# Run every repomix split part from the repo root.
# Requires Node + npx (repomix is fetched on demand if not installed).
# Outputs land in repomix/output/ (gitignored, never committed).
$parts = @("core-runtime", "core-ui", "supabase", "docs", "tests", "tooling", "full")
foreach ($part in $parts) {
  Write-Host "=== repomix: $part ==="
  npx repomix --config "repomix/repomix.config.$part.json"
}
Write-Host "Done. Outputs are in repomix/output/."
