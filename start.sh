#!/bin/bash

echo "Pulling via GIT"
# FIX: Remove git index.lock file if it exists due to a previous crash
# This prevents "fatal: Unable to create '/home/container/.git/index.lock': File exists." errors
rm -f /home/container/.git/index.lock
git reset --hard
git pull https://github.com/M1noa/disscord-bot-to-web-chat

/usr/local/bin/npm install --no-audit --no-fund

echo "Starting application..."
/usr/local/bin/node server.js  --expose-gc ${NODE_ARGS}
echo "Stopped."