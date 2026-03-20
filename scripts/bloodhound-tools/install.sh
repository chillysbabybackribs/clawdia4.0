#!/bin/bash
# Run this to copy bloodhound-tools from Claude's output to the Clawdia scripts directory
# Usage: bash install.sh

DEST="/home/dp/Desktop/clawdia4.0/scripts/bloodhound-tools"
# The files are available as downloads from the Claude chat — save them to a temp location first
# Then run: cp auditor.ts seeder.ts template-patch.ts package.json README.md "$DEST/"

echo "Bloodhound tools installer"
echo "=========================="
echo ""
echo "The files have been generated and are available as downloads in the Claude chat."
echo "Save all 5 files to: $DEST"
echo ""
echo "Then run:"
echo "  cd $DEST"
echo "  npm install"
echo ""
echo "Quick start:"
echo "  npm run seed:dry     # Preview seeded executors"
echo "  npm run seed         # Insert 20+ micro-executors"
echo "  npm run audit        # Mine history for candidates"
echo "  npm run audit:promote  # Interactive promotion"
