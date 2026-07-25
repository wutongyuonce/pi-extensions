#!/bin/bash
# Assembles the course from parts.
# Run from the course directory: bash build.sh
set -e
cat _base.html \
  modules/01-overview.html \
  modules/02-configuration.html \
  modules/03-lifecycle.html \
  modules/04-runtime.html \
  modules/05-reliability.html \
  modules/06-build-from-zero.html \
  _footer.html > index.html
echo "Built index.html — open it in your browser."
