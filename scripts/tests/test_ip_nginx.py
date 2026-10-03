import importlib.util
from pathlib import Path
import sys
import unittest


MODULE_PATH = Path(__file__).resolve().parents[1] / "ip_nginx.py"
SPEC = importlib.util.spec_from_file_location("ip_nginx", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)
render_ip_config = MODULE.render_ip_config
IP = "185.172.64.24"


class RenderIpConfigTests(unittest.TestCase):
    def test_preserves_named_domain_and_other_directives_verbatim(self):
        existing = '''# existing routing\nmap $http_upgrade $connection_upgrade {
    default upgrade;
    "" close;
}
server {
    listen 80 default_server;
    server_name example.com www.example.com;
    location / { return 301 https://example.com$request_uri; }
}
server {
    listen 443 ssl http2;
    server_name example.com;
    ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem;
    location / { proxy_pass http://legacy; }
}
'''
        result = render_ip_config(existing, IP)
        self.assertTrue(result.endswith(existing))
        self.assertLess(result.index("server_name " + IP), result.index("# existing routing"))
        self.assertEqual(result.count("listen 443 ssl default_server;"), 1)

    def test_replaces_all_exact_ip_servers_without_removing_neighbors(self):
        before = "# keep before\nserver { listen 8080; server_name internal; }\n"
        after = "\n# keep after\ninclude /etc/nginx/extra/*.conf;\n"
        old = ('server { listen 80; server_name "' + IP + '"; return 200 old; }\n'
               'server { listen 443 ssl default_server; server_name ' + IP + '; }')
        result = render_ip_config(before + old + after, IP)
        self.assertIn(before, result)
        self.assertTrue(result.endswith(after))
        self.assertNotIn("return 200 old", result)
        self.assertEqual(result.count("server_name " + IP + ";"), 2)
        repeated = render_ip_config(result, IP)
        self.assertEqual(repeated.count("server_name " + IP + ";"), 2)
        self.assertEqual(repeated.count("listen 443 ssl default_server;"), 1)

    def test_rejects_mixed_ip_and_domain_names(self):
        for names in (IP + " example.com", '"" ' + IP, IP + "; server_name example.com"):
            with self.subTest(names=names), self.assertRaisesRegex(ValueError, "mixes"):
                render_ip_config("server { listen 443 ssl; server_name " + names + "; }", IP)

    def test_preserves_same_ip_services_on_unrelated_ports(self):
        for listen in ("8080", IP + ":8443 ssl default_server", "unix:/tmp/ip-service"):
            existing = "server { listen " + listen + "; server_name " + IP + "; return 200 retained; }"
            with self.subTest(listen=listen):
                self.assertTrue(render_ip_config(existing, IP).endswith(existing))

    def test_rejects_same_ip_server_sharing_website_and_unrelated_ports(self):
        for listeners in ("listen 443 ssl; listen 8443 ssl;", "listen 80; listen unix:/tmp/ip-service;"):
            existing = "server { " + listeners + " server_name " + IP + "; }"
            with self.subTest(listeners=listeners), self.assertRaisesRegex(ValueError, "mixes website ports"):
                render_ip_config(existing, IP)

    def test_replaces_same_ip_server_with_implicit_port_80(self):
        existing = "server { server_name " + IP + "; return 200 obsolete; }"
        result = render_ip_config(existing, IP)
        self.assertNotIn("obsolete", result)
        self.assertEqual(result.count("server_name " + IP + ";"), 2)

    def test_rejects_preserved_tls_default_but_allows_http_default(self):
        for default in ("default_server", "default"):
            with self.subTest(default=default), self.assertRaisesRegex(ValueError, "default_server"):
                render_ip_config("server { listen 443 ssl " + default + "; server_name example.com; }", IP)
        render_ip_config("server { listen 80 default_server; server_name example.com; }", IP)

    def test_rejects_socket_layouts_that_can_override_or_change_ip_listeners(self):
        listeners = ("[::]:443 ssl", "0.0.0.0:443 ssl", IP + ":443 ssl",
                     IP + ":80", "[::]:80 ipv6only=off", "127.0.0.1", "443 ssl proxy_protocol",
                     "443 quic reuseport", "80 ssl", "80 proxy_protocol")
        for listen in listeners:
            with self.subTest(listen=listen), self.assertRaisesRegex(ValueError, "Unsupported"):
                render_ip_config("server { listen " + listen + "; server_name example.com; }", IP)

    def test_preserves_unrelated_ports_and_unix_sockets(self):
        existing = "server { listen 127.0.0.1:8443 ssl default_server; listen unix:/tmp/app; server_name internal; }"
        self.assertTrue(render_ip_config(existing, IP).endswith(existing))

    def test_comments_quotes_escapes_and_braced_variables_do_not_change_block_boundaries(self):
        existing = r'''# server { listen 443 default_server; server_name 185.172.64.24; } }
server {
    listen 443 ssl;
    server_name ${DOMAIN};
    # } } { ignored
    location / {
        return 200 "a \"quoted\" { brace }; # retained";
        add_header X-Test 'single } { quote';
        add_header X-Escaped escaped\{brace\};
    }
}
'''
        self.assertTrue(render_ip_config(existing, IP).endswith(existing))

    def test_rejects_unmatched_braces_and_unterminated_quotes(self):
        for existing in ("server { listen 443 ssl;", "server { } }", 'server { return 200 "} ; }',
                         "server { location / { return 200 ok; }", "server { server_name ${DOMAIN; }"):
            with self.subTest(existing=existing), self.assertRaises(ValueError):
                render_ip_config(existing, IP)

    def test_requires_a_public_canonical_ipv4(self):
        for ip in ("127.0.0.1", "10.1.2.3", "192.168.1.1", "198.51.100.1", "169.254.1.1",
                   "224.0.0.1", "240.0.0.1", "0.0.0.0", "::1", "example.com", "185.172.064.24"):
            with self.subTest(ip=ip), self.assertRaisesRegex(ValueError, "public IPv4"):
                render_ip_config("", ip)

    def test_ip_servers_have_the_certificate_and_existing_application_routes(self):
        result = render_ip_config("", IP)
        self.assertIn("listen 443 ssl default_server;", result)
        self.assertIn("/etc/letsencrypt-ip/live/" + IP + "/fullchain.pem;", result)
        self.assertIn("/etc/letsencrypt-ip/live/" + IP + "/privkey.pem;", result)
        self.assertIn("location /.well-known/acme-challenge/ {\n        root /var/www/certbot;", result)
        self.assertIn("return 301 https://" + IP + "$request_uri;", result)
        self.assertIn("location /api/ {\n        proxy_pass http://api:4000/;", result)
        self.assertIn("try_files $uri /app/index.html;", result)
        self.assertIn("frame-ancestors 'self' https://web.telegram.org https://*.telegram.org", result)
        self.assertIn("try_files $uri $uri/ /index.html;", result)

    def test_accepts_repository_template_without_rewriting_it(self):
        root = MODULE_PATH.parents[1]
        existing = (root / "docker/nginx/default.conf.template").read_text()
        self.assertTrue(render_ip_config(existing, IP).endswith(existing))

    def test_custom_port_preserves_existing_http_https_and_unrelated_defaults_verbatim(self):
        existing = ("# Existing IP and domain services\n"
                    "server { listen 80 default_server; server_name " + IP + "; }\n"
                    "server { listen 443 ssl default_server; server_name " + IP + "; }\n"
                    "server { listen " + IP + ":443 ssl; server_name example.com " + IP + "; }\n"
                    "server { listen [::]:443 ssl default_server; server_name ipv6.example.com; }\n"
                    "server { listen 9443 ssl default_server; server_name " + IP + "; }\n"
                    "server { server_name " + IP + "; return 200 implicit_http; }\n")
        result = render_ip_config(existing, IP, https_port=8443)
        self.assertTrue(result.endswith(existing))
        added = result[:-len(existing)]
        self.assertEqual(added.count("server {"), 1)
        self.assertIn("listen 8443 ssl default_server;", added)
        self.assertNotIn("listen 80;", added)
        self.assertNotIn("return 301", added)

    def test_custom_port_replaces_only_target_ip_target_port_and_does_not_duplicate(self):
        retained = ("server { listen 443 ssl default_server; server_name " + IP + "; }\n"
                    "server { listen 8443 ssl; server_name example.com; return 200 retained; }\n")
        obsolete = "server { listen 8443 ssl default_server; server_name " + IP + "; return 200 obsolete; }"
        result = render_ip_config(retained + obsolete, IP, 8443)
        self.assertIn(retained, result)
        self.assertNotIn("obsolete", result)
        repeated = render_ip_config(result, IP, 8443)
        self.assertIn(retained, repeated)
        self.assertEqual(repeated.count("listen 8443 ssl default_server;"), 1)
        self.assertEqual(repeated.count("server_name " + IP + ";"), 2)

    def test_custom_port_rejects_shared_names_or_shared_listener_ports(self):
        configs = ("server { listen 8443 ssl; server_name " + IP + " example.com; }",
                   "server { listen 8443 ssl; listen 443 ssl; server_name " + IP + "; }",
                   "server { listen 8443 ssl; listen 80; server_name " + IP + "; }",
                   "server { listen 8443 ssl; listen 9443 ssl; server_name " + IP + "; }")
        for existing in configs:
            with self.subTest(existing=existing), self.assertRaisesRegex(ValueError, "mixes"):
                render_ip_config(existing, IP, 8443)

    def test_custom_port_rejects_conflicting_preserved_sockets_only_on_its_port(self):
        listeners = ("8443 ssl default_server", "8443 default", "[::]:8443 ssl",
                     IP + ":8443 ssl", "0.0.0.0:8443 ssl", "8443 ssl proxy_protocol")
        for listen in listeners:
            with self.subTest(listen=listen), self.assertRaises(ValueError):
                render_ip_config("server { listen " + listen + "; server_name example.com; }", IP, 8443)

    def test_custom_port_preserves_routes_certificates_and_forwarded_origin(self):
        result = render_ip_config("", IP, 8443)
        self.assertIn("/etc/letsencrypt-ip/live/" + IP + "/fullchain.pem;", result)
        self.assertIn("/etc/letsencrypt-ip/live/" + IP + "/privkey.pem;", result)
        self.assertIn("proxy_pass http://api:4000/;", result)
        self.assertIn("proxy_set_header Host $http_host;", result)
        self.assertIn("proxy_set_header X-Forwarded-Port 8443;", result)
        self.assertIn("try_files $uri /app/index.html;", result)
        self.assertIn("frame-ancestors 'self' https://web.telegram.org https://*.telegram.org", result)
        self.assertIn("try_files $uri $uri/ /index.html;", result)
        default = render_ip_config("", IP)
        self.assertEqual(default, render_ip_config("", IP, 443))
        self.assertIn("proxy_set_header Host $host;", default)
        self.assertNotIn("X-Forwarded-Port", default)

    def test_https_port_requires_strict_integer_in_range_and_excludes_http_port(self):
        for port in (True, False, "8443", 8443.0, None, 0, -1, 65536, 80):
            with self.subTest(port=port), self.assertRaisesRegex(ValueError, "HTTPS port"):
                render_ip_config("", IP, port)
        for port in (1, 65535):
            with self.subTest(port=port):
                self.assertIn("listen %s ssl default_server;" % port, render_ip_config("", IP, port))


if __name__ == "__main__":
    unittest.main()
