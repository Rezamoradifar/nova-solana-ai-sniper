"""Add an IPv4 HTTPS site while retaining existing named-domain nginx servers."""

import ipaddress
from dataclasses import dataclass
from typing import List, Optional, Tuple


@dataclass
class _Token:
    value: str
    start: int
    end: int
    kind: str = "word"


@dataclass
class _Statement:
    head: List[_Token]
    end: int
    children: List["_Statement"]
    block: bool


def _tokens(source: str) -> List[_Token]:
    """Read nginx words without mistaking quoted/comment/variable braces for blocks."""
    result = []
    i = 0
    while i < len(source):
        if source[i].isspace():
            i += 1
            continue
        if source[i] == "#":
            end = source.find("\n", i)
            i = len(source) if end < 0 else end + 1
            continue
        if source[i] in "{};":
            result.append(_Token(source[i], i, i + 1, source[i]))
            i += 1
            continue
        start = i
        word = []
        while i < len(source) and not source[i].isspace() and source[i] not in "{};#":
            char = source[i]
            if char in "\"'":
                quote = char
                i += 1
                while i < len(source) and source[i] != quote:
                    if source[i] == "\\":
                        i += 1
                        if i == len(source):
                            raise ValueError("Unterminated nginx quoted string")
                    word.append(source[i])
                    i += 1
                if i == len(source):
                    raise ValueError("Unterminated nginx quoted string")
                i += 1
            elif char == "\\":
                i += 1
                if i == len(source):
                    raise ValueError("Unterminated nginx escape")
                word.append(source[i])
                i += 1
            elif source.startswith("${", i):
                end = source.find("}", i + 2)
                if end < 0 or not source[i + 2:end].replace("_", "a").isalnum():
                    raise ValueError("Malformed nginx variable")
                word.append(source[i:end + 1])
                i = end + 1
            else:
                word.append(char)
                i += 1
        result.append(_Token("".join(word), start, i))
    return result


def _statements(tokens: List[_Token], offset: int = 0, nested: bool = False
                ) -> Tuple[List[_Statement], int]:
    result = []
    head = []
    while offset < len(tokens):
        token = tokens[offset]
        offset += 1
        if token.kind == "word":
            head.append(token)
        elif token.kind == "}":
            if not nested or head:
                raise ValueError("Unmatched nginx brace or unfinished directive")
            return result, offset
        elif not head:
            raise ValueError("Nginx directive is missing its name")
        elif token.kind == ";":
            result.append(_Statement(head, token.end, [], False))
            head = []
        else:
            children, offset = _statements(tokens, offset, True)
            result.append(_Statement(head, tokens[offset - 1].end, children, True))
            head = []
    if nested or head:
        raise ValueError("Unmatched nginx brace or unfinished directive")
    return result, offset


def _listen_port(statement: _Statement) -> Optional[int]:
    words = [token.value for token in statement.head[1:]]
    if not words:
        raise ValueError("Nginx listen directive has no address")
    endpoint = words[0]
    if endpoint.startswith("unix:"):
        return None
    if endpoint.isdigit():
        return int(endpoint)
    if ":" in endpoint and endpoint.rsplit(":", 1)[1].isdigit():
        return int(endpoint.rsplit(":", 1)[1])
    return 80  # An address without a port uses nginx's HTTP default port.


def _check_listen(statement: _Statement, https_port: int) -> None:
    port = _listen_port(statement)
    target_ports = (80, 443) if https_port == 443 else (https_port,)
    if port not in target_ports:
        return
    words = [token.value for token in statement.head[1:]]
    endpoint, options = words[0], words[1:]
    if endpoint != str(port):
        raise ValueError("Unsupported address-specific listen on port %s: %s" % (port, endpoint))
    if port == https_port and any(option in ("default", "default_server") for option in options):
        raise ValueError("A preserved server already declares a port %s default_server" % port)
    allowed = {"ssl", "http2"} if port == https_port else {"default", "default_server"}
    unsupported = set(options) - allowed
    if unsupported:
        raise ValueError("Unsupported listen %s option: %s" % (port, sorted(unsupported)[0]))


def render_ip_config(existing: str, ip: str, https_port: int = 443) -> str:
    """Render a public-IP site first; reject ambiguous or conflicting socket layouts.

    Input is a conf.d-style configuration containing top-level server blocks.
    Port 443 mode manages HTTP 80 and HTTPS 443. A custom HTTPS port manages only
    that port, retaining existing HTTP and HTTPS sites. Address-specific sockets
    and other socket options on managed ports require operator review because
    they can override or alter the new listeners.
    """
    if type(https_port) is not int or not 1 <= https_port <= 65535 or https_port == 80:
        raise ValueError("HTTPS port must be an integer from 1 to 65535 other than 80")
    try:
        address = ipaddress.IPv4Address(ip)
    except (ipaddress.AddressValueError, TypeError) as error:
        raise ValueError("A public IPv4 address is required") from error
    if (str(address) != ip or not address.is_global or address.is_multicast
            or address.is_reserved or address.is_unspecified):
        raise ValueError("A public IPv4 address is required")

    statements, _ = _statements(_tokens(existing))
    target_ports = (80, 443) if https_port == 443 else (https_port,)
    removed = []
    for statement in statements:
        if not statement.block or [token.value for token in statement.head] != ["server"]:
            continue
        names = [token.value for child in statement.children
                 if not child.block and child.head[0].value == "server_name"
                 for token in child.head[1:]]
        listeners = [child for child in statement.children
                     if not child.block and child.head[0].value == "listen"]
        if ip in names:
            ports = [_listen_port(listener) for listener in listeners] or [80]
            manages_server = any(port in target_ports for port in ports)
            if (https_port == 443 or manages_server) and any(name != ip for name in names):
                raise ValueError("A server_name mixes the target IP with other names")
            if manages_server:
                if any(port not in target_ports for port in ports):
                    raise ValueError("Target IP server mixes website ports %s with other listeners"
                                     % "/".join(str(port) for port in target_ports))
                removed.append((statement.head[0].start, statement.end))
                continue
        for listener in listeners:
            _check_listen(listener, https_port)

    chunks = []
    cursor = 0
    for start, end in removed:
        chunks.append(existing[cursor:start])
        cursor = end
    chunks.append(existing[cursor:])
    if https_port == 443:
        new_servers = _IP_HTTP_SERVER + _IP_HTTPS_SERVER
    else:
        new_servers = _IP_HTTPS_SERVER.replace("listen 443 ssl default_server;",
                                              "listen %s ssl default_server;" % https_port)
        new_servers = new_servers.replace("proxy_set_header Host $host;",
                                         "proxy_set_header Host $http_host;\n"
                                         "        proxy_set_header X-Forwarded-Port %s;" % https_port)
    return new_servers.replace("@IP@", ip) + "".join(chunks)


_IP_HTTP_SERVER = """server {
    listen 80;
    server_name @IP@;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://@IP@$request_uri;
    }
}

"""

_IP_HTTPS_SERVER = """server {
    listen 443 ssl default_server;
    http2 on;
    server_name @IP@;

    ssl_certificate /etc/letsencrypt-ip/live/@IP@/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt-ip/live/@IP@/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    client_max_body_size 5m;

    location /api/ {
        proxy_pass http://api:4000/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /app/ {
        root /usr/share/nginx/html;
        try_files $uri /app/index.html;
        add_header Content-Security-Policy "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    }

    location / {
        root /usr/share/nginx/html;
        try_files $uri $uri/ /index.html;
    }
}

"""
