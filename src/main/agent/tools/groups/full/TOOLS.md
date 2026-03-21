# Tool Definitions — Full Group
# ═══════════════════════════════════
# This group contains ALL tools: core + browser + extras.
# Used when the classifier can't narrow down, or after mid-loop escalation.
#
# Note: This file lists the additional tools not in core or browser.
# The full group's tools.ts will import core tools + browser tools + these.
# ═══════════════════════════════════


## create_document

name: create_document
description: |
  Create a document file (docx, pdf, xlsx, csv, md, html, json, txt).
  For docx/pdf: pass markdown-formatted content. For xlsx/csv: pass
  structured_data as an array of objects. Saves to ~/Documents/Clawdia/
  by default. Returns the absolute path of the created file.

input_schema:
  type: object
  properties:
    filename:
      type: string
      description: Filename with extension (e.g. "report.docx", "data.xlsx")
    format:
      type: string
      enum: [docx, pdf, xlsx, csv, md, html, json, txt]
      description: Output format
    content:
      type: string
      description: Markdown content (for docx, pdf, md, html, txt)
    structured_data:
      type: array
      description: Array of objects (for xlsx, csv, json)
    output_dir:
      type: string
      description: Custom output directory (default ~/Documents/Clawdia/)
  required: [filename, format]


## memory_search

name: memory_search
description: |
  Search the user's persistent memory for previously stored facts,
  preferences, and context. Uses full-text search. Returns matching
  memory entries with category, key, and value. Use when the user
  references something from a past conversation or asks "do you remember."

input_schema:
  type: object
  properties:
    query:
      type: string
      description: Search terms to find in memory
    limit:
      type: number
      description: Max results to return (default 5)
  required: [query]


## memory_store

name: memory_store
description: |
  Store a fact about the user in persistent memory. Use when the user
  shares a personal detail, preference, or workflow habit; explicitly asks
  to remember something; or you learn something useful about their setup
  or projects. Do NOT store secrets, passwords, or API keys.
  Categories: preference, account, workflow, fact, context.

input_schema:
  type: object
  properties:
    category:
      type: string
      enum: [preference, account, workflow, fact, context]
      description: Memory category
    key:
      type: string
      description: Short label (e.g. "editor_preference", "twitter_handle")
    value:
      type: string
      description: The fact to remember
  required: [category, key, value]
