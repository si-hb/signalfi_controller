/#!/usr/bin/env bash
set -e

REMOTE_HOST="root@weather.apis.symphonyinteractive.ca"
REMOTE_PATH="/opt/signalfi_controller"

echo "==> Staging all changes..."
git add -A

if git diff --cached --quiet; then
  echo "Nothing to commit — pushing and deploying current HEAD."
else
  # Commit message from first arg, or prompt
  MSG="${1:-}"
  if [[ -z "$MSG" ]]; then
    read -r -p "Commit message: " MSG
  fi
  if [[ -z "$MSG" ]]; then
    echo "Abort: commit message required." >&2
    exit 1
  fi
  echo "==> Committing: $MSG"
  git commit -m "$MSG"
fi

echo "==> Pushing to origin/master..."
git push origin master

echo "==> Deploying to remote..."
ssh "$REMOTE_HOST" "cd $REMOTE_PATH && git pull && docker compose up -d --build"

echo "==> Done."
