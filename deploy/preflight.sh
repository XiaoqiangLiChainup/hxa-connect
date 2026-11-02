#!/bin/sh
# Read-only deployment inventory. Does not read tokens, environment files,
# model authentication files, container environments, or conversation logs.
set -u

printf '== Deployment environment ==\n'
printf 'os: '
uname -s
printf 'architecture: '
uname -m
printf 'uid: '
id -u
if [ -f /.dockerenv ] || [ -f /run/.containerenv ]; then
  printf 'container_hint: yes; host deployment access must be checked separately\n'
else
  printf 'container_hint: not detected; this is not proof of host access\n'
fi

for task_tool in docker node npm git zylos nginx caddy; do
  if command -v "$task_tool" >/dev/null 2>&1; then
    printf '%s: available\n' "$task_tool"
  else
    printf '%s: unavailable\n' "$task_tool"
  fi
done

if command -v docker >/dev/null 2>&1; then
  docker --version
  docker compose version --short 2>/dev/null || printf 'compose_v2: unavailable\n'
  if task_docker_version=$(docker version --format '{{.Server.Version}}' 2>/dev/null); then
    printf 'docker_server: %s\n' "$task_docker_version"
  else
    printf 'docker_server: not accessible from this execution context\n'
  fi
fi
if command -v node >/dev/null 2>&1; then node --version; fi
if command -v zylos >/dev/null 2>&1; then zylos --version; fi

if command -v ss >/dev/null 2>&1; then
  printf '== Existing TCP listeners on common Hub/pilot ports 4800 and 4801 ==\n'
  ss -ltn '( sport = :4800 or sport = :4801 )' 2>/dev/null || true
fi
printf 'No services were installed, upgraded, restarted, or reconfigured.\n'
