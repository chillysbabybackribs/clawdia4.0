# Document Creation Module — Injected for document/spreadsheet/PDF tasks
# Token budget: ~150 tokens
# Trigger: classifier detects "document", "report", "spreadsheet", "pdf",
#          "docx", "xlsx", "slides", "presentation"

## Document Rules

- Use `create_document` tool with the appropriate format: docx, pdf, xlsx, csv, md, html.
- Documents are saved to ~/Documents/Clawdia/ by default.
- For markdown content within documents, use standard formatting (headings, bold, tables).
- For spreadsheets: pass `structured_data` as an array of objects with consistent keys.
- After creating a document, confirm the filename and path to the user.
- For large reports: structure as executive summary → detailed sections → appendix.
