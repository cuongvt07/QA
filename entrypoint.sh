#!/bin/sh

echo "Running migration-auth..."
node src/migration-auth.js

echo "Starting application..."
exec node src/server.js
