#!/usr/bin/env bash
# Real Docker regression: rebuild removes old default tags; archived rollback
# tags must restore the exact previous image without registry pulls.
set -euo pipefail
fixture=$(mktemp -d)
project="nova-rollback-test-$$-${RANDOM}"
api_tag="$project-api:rollback"
web_tag="$project-web:rollback"
dc=(docker compose -p "$project" -f "$fixture/compose.yml")
cleanup() {
  "${dc[@]}" down --remove-orphans >/dev/null 2>&1 || true
  docker image rm "$api_tag" "$web_tag" "$project-api" "$project-gsp-web" >/dev/null 2>&1 || true
  rm -rf "$fixture"
}
trap cleanup EXIT
cat > "$fixture/Dockerfile" <<'EOF'
FROM alpine:3.20
LABEL revision=previous
CMD ["sleep", "300"]
EOF
cat > "$fixture/compose.yml" <<'EOF'
services:
  api:
    build: .
  gsp-web:
    build: .
EOF
"${dc[@]}" build api gsp-web
"${dc[@]}" up -d --no-build --pull never api gsp-web
api_old=$(docker inspect --format '{{.Image}}' "$("${dc[@]}" ps -q api)")
web_old=$(docker inspect --format '{{.Image}}' "$("${dc[@]}" ps -q gsp-web)")
docker image tag "$api_old" "$api_tag"
docker image tag "$web_old" "$web_tag"
docker image save --output "$fixture/images.tar" "$api_tag" "$web_tag"
printf '\nLABEL revision=current\n' >> "$fixture/Dockerfile"
"${dc[@]}" build api gsp-web
"${dc[@]}" up -d --no-build --pull never api gsp-web
[[ "$(docker inspect --format '{{.Image}}' "$("${dc[@]}" ps -q api)")" != "$api_old" ]]
"${dc[@]}" config --images api gsp-web > "$fixture/current-images"
while IFS= read -r image; do docker image inspect "$image" >/dev/null; done < "$fixture/current-images"
docker image rm "$api_tag" "$web_tag"
if docker image inspect "$api_tag" >/dev/null 2>&1; then
  echo 'Expected missing rollback tag before archive reload.' >&2; exit 1
fi
docker image load --input "$fixture/images.tar"
printf 'services:\n  api:\n    image: "%s"\n    pull_policy: never\n  gsp-web:\n    image: "%s"\n    pull_policy: never\n' "$api_tag" "$web_tag" > "$fixture/rollback.yml"
"${dc[@]}" -f "$fixture/rollback.yml" run --rm --no-deps --pull never -T api true
"${dc[@]}" -f "$fixture/rollback.yml" up -d --no-deps --no-build --pull never api gsp-web
[[ "$(docker inspect --format '{{.Image}}' "$("${dc[@]}" ps -q api)")" == "$api_old" ]]
[[ "$(docker inspect --format '{{.Image}}' "$("${dc[@]}" ps -q gsp-web)")" == "$web_old" ]]
echo 'DOCKER_ROLLBACK_OK: both exact previous images restored from archive.'
