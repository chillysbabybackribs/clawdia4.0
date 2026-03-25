/**
 * Extra Tool Executors — create_document, memory_search, memory_store
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { searchMemory, remember, type MemoryEntry } from '../../db/memory';
import { searchPastConversations } from '../../db/conversation-recall';
import { normalizeFsPath } from './core/fs-paths';

const execAsync = promisify(exec);
const DOCS_DIR = path.join(homedir(), 'Documents', 'Clawdia');

// ═══════════════════════════════════
// Binary Document Generation via Python
//
// For docx/pdf/xlsx, we generate a temporary Python script and execute it.
// This avoids adding heavy Node dependencies to the Electron build while
// producing valid binary files that open correctly in native applications.
//
// Required libraries (checked at runtime):
//   docx  → python-docx   (pip install python-docx)
//   pdf   → reportlab     (pip install reportlab)
//   xlsx  → openpyxl      (pip install openpyxl)
// ═══════════════════════════════════

/** Cache of Python library availability checks. */
const pyLibCache: Record<string, boolean> = {};

async function hasPyLib(lib: string): Promise<boolean> {
  if (lib in pyLibCache) return pyLibCache[lib];
  try {
    await execAsync(`python3 -c "import ${lib}" 2>/dev/null`, { timeout: 5000 });
    pyLibCache[lib] = true;
  } catch {
    pyLibCache[lib] = false;
  }
  return pyLibCache[lib];
}

/**
 * Generate a DOCX file via python-docx.
 * Parses markdown-like content: lines starting with # become headings,
 * lines starting with - or * become bullet points, everything else is a paragraph.
 */
async function generateDocx(filePath: string, content: string): Promise<string> {
  if (!await hasPyLib('docx')) {
    return `[Error] python-docx is not installed. Run: pip install python-docx --break-system-packages`;
  }

  const scriptPath = `/tmp/clawdia-gen-docx-${Date.now()}.py`;
  // Escape content for safe embedding in a Python triple-quoted string
  const safeContent = content.replace(/\\/g, '\\\\').replace(/'''/g, "\\'\\'\\'");

  const script = `
import sys
from docx import Document
from docx.shared import Pt, Inches
from docx.enum.text import WD_ALIGN_PARAGRAPH

content = '''${safeContent}'''
output_path = '''${filePath}'''

doc = Document()
style = doc.styles['Normal']
style.font.size = Pt(11)
style.font.name = 'Calibri'

for line in content.split('\\n'):
    stripped = line.strip()
    if not stripped:
        doc.add_paragraph('')
    elif stripped.startswith('### '):
        doc.add_heading(stripped[4:], level=3)
    elif stripped.startswith('## '):
        doc.add_heading(stripped[3:], level=2)
    elif stripped.startswith('# '):
        doc.add_heading(stripped[2:], level=1)
    elif stripped.startswith('- ') or stripped.startswith('* '):
        doc.add_paragraph(stripped[2:], style='List Bullet')
    elif stripped.startswith(('1.', '2.', '3.', '4.', '5.', '6.', '7.', '8.', '9.')):
        text = stripped.split('. ', 1)[1] if '. ' in stripped else stripped
        doc.add_paragraph(text, style='List Number')
    else:
        doc.add_paragraph(stripped)

doc.save(output_path)
print(f'OK:{output_path}')
`;

  fs.writeFileSync(scriptPath, script, 'utf-8');
  try {
    const { stdout, stderr } = await execAsync(`python3 "${scriptPath}"`, {
      timeout: 15000, cwd: homedir(),
    });
    if (stderr.trim()) console.log(`[create_document] docx stderr: ${stderr.trim()}`);
    if (stdout.includes('OK:')) return `[Created ${filePath}]`;
    return `[Error] DOCX generation produced no output: ${stdout.slice(0, 200)}`;
  } catch (err: any) {
    return `[Error generating DOCX]: ${err.stderr || err.message}`;
  } finally {
    try { fs.unlinkSync(scriptPath); } catch {}
  }
}

/**
 * Generate a PDF file via reportlab.
 * Renders content as a simple formatted document with automatic line wrapping.
 */
async function generatePdf(filePath: string, content: string): Promise<string> {
  if (!await hasPyLib('reportlab')) {
    return `[Error] reportlab is not installed. Run: pip install reportlab --break-system-packages`;
  }

  const scriptPath = `/tmp/clawdia-gen-pdf-${Date.now()}.py`;
  const safeContent = content.replace(/\\/g, '\\\\').replace(/'''/g, "\\'\\'\\'");

  const script = `
import sys
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, ListFlowable, ListItem
from reportlab.lib.enums import TA_LEFT

content = '''${safeContent}'''
output_path = '''${filePath}'''

doc = SimpleDocTemplate(output_path, pagesize=letter,
    topMargin=0.75*inch, bottomMargin=0.75*inch,
    leftMargin=0.75*inch, rightMargin=0.75*inch)
styles = getSampleStyleSheet()

# Custom styles
title_style = ParagraphStyle('DocTitle', parent=styles['Heading1'], fontSize=18, spaceAfter=12)
h2_style = ParagraphStyle('DocH2', parent=styles['Heading2'], fontSize=14, spaceAfter=8)
h3_style = ParagraphStyle('DocH3', parent=styles['Heading3'], fontSize=12, spaceAfter=6)
body_style = styles['BodyText']
bullet_style = ParagraphStyle('DocBullet', parent=body_style, leftIndent=20, bulletIndent=10)

story = []
for line in content.split('\\n'):
    stripped = line.strip()
    if not stripped:
        story.append(Spacer(1, 6))
    elif stripped.startswith('### '):
        story.append(Paragraph(stripped[4:], h3_style))
    elif stripped.startswith('## '):
        story.append(Paragraph(stripped[3:], h2_style))
    elif stripped.startswith('# '):
        story.append(Paragraph(stripped[2:], title_style))
    elif stripped.startswith('- ') or stripped.startswith('* '):
        story.append(Paragraph('\u2022 ' + stripped[2:], bullet_style))
    else:
        story.append(Paragraph(stripped, body_style))

if not story:
    story.append(Paragraph('(Empty document)', body_style))

doc.build(story)
print(f'OK:{output_path}')
`;

  fs.writeFileSync(scriptPath, script, 'utf-8');
  try {
    const { stdout, stderr } = await execAsync(`python3 "${scriptPath}"`, {
      timeout: 15000, cwd: homedir(),
    });
    if (stderr.trim()) console.log(`[create_document] pdf stderr: ${stderr.trim()}`);
    if (stdout.includes('OK:')) return `[Created ${filePath}]`;
    return `[Error] PDF generation produced no output: ${stdout.slice(0, 200)}`;
  } catch (err: any) {
    return `[Error generating PDF]: ${err.stderr || err.message}`;
  } finally {
    try { fs.unlinkSync(scriptPath); } catch {}
  }
}

/**
 * Generate an XLSX file via openpyxl.
 * Uses structured_data (array of objects) if available, otherwise
 * attempts to parse content as a simple table.
 */
async function generateXlsx(
  filePath: string,
  content: string,
  structuredData?: any[],
): Promise<string> {
  if (!await hasPyLib('openpyxl')) {
    return `[Error] openpyxl is not installed. Run: pip install openpyxl --break-system-packages`;
  }

  const scriptPath = `/tmp/clawdia-gen-xlsx-${Date.now()}.py`;
  const dataPath = `/tmp/clawdia-gen-xlsx-data-${Date.now()}.json`;

  // Write data to a JSON file to avoid shell escaping nightmares
  const data = structuredData && structuredData.length > 0
    ? structuredData
    : null;

  fs.writeFileSync(dataPath, JSON.stringify({
    rows: data,
    text: data ? null : content,
    output: filePath,
  }), 'utf-8');

  const script = `
import json, sys
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment

with open('${dataPath}', 'r') as f:
    spec = json.load(f)

wb = Workbook()
ws = wb.active
ws.title = 'Sheet1'

header_font = Font(bold=True, size=11)
header_fill = PatternFill(start_color='D9E1F2', end_color='D9E1F2', fill_type='solid')

if spec.get('rows') and len(spec['rows']) > 0:
    # Structured data: array of objects
    headers = list(spec['rows'][0].keys())
    for col, h in enumerate(headers, 1):
        cell = ws.cell(row=1, column=col, value=h)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = Alignment(horizontal='center')
    for ri, row in enumerate(spec['rows'], 2):
        for col, h in enumerate(headers, 1):
            val = row.get(h, '')
            # Try to convert numeric strings
            try:
                val = float(val) if '.' in str(val) else int(val)
            except (ValueError, TypeError):
                pass
            ws.cell(row=ri, column=col, value=val)
    # Auto-width columns
    for col in range(1, len(headers) + 1):
        max_len = max(len(str(ws.cell(row=r, column=col).value or '')) for r in range(1, len(spec['rows']) + 2))
        ws.column_dimensions[ws.cell(row=1, column=col).column_letter].width = min(max_len + 4, 40)
elif spec.get('text'):
    # Plain text: split into rows, tab/comma-separated columns
    lines = spec['text'].strip().split('\\n')
    for ri, line in enumerate(lines, 1):
        sep = '\\t' if '\\t' in line else ','
        for ci, cell in enumerate(line.split(sep), 1):
            val = cell.strip().strip('"')
            try:
                val = float(val) if '.' in val else int(val)
            except (ValueError, TypeError):
                pass
            c = ws.cell(row=ri, column=ci, value=val)
            if ri == 1:
                c.font = header_font
                c.fill = header_fill
else:
    ws.cell(row=1, column=1, value='(Empty spreadsheet)')

wb.save(spec['output'])
print(f"OK:{spec['output']}")
`;

  fs.writeFileSync(scriptPath, script, 'utf-8');
  try {
    const { stdout, stderr } = await execAsync(`python3 "${scriptPath}"`, {
      timeout: 15000, cwd: homedir(),
    });
    if (stderr.trim()) console.log(`[create_document] xlsx stderr: ${stderr.trim()}`);
    if (stdout.includes('OK:')) return `[Created ${filePath}]`;
    return `[Error] XLSX generation produced no output: ${stdout.slice(0, 200)}`;
  } catch (err: any) {
    return `[Error generating XLSX]: ${err.stderr || err.message}`;
  } finally {
    try { fs.unlinkSync(scriptPath); } catch {}
    try { fs.unlinkSync(dataPath); } catch {}
  }
}

export async function executeCreateDocument(input: Record<string, any>): Promise<string> {
  const { filename, format, content, structured_data, output_dir } = input;
  const dir = output_dir || DOCS_DIR;

  try {
    const rawFilename = String(filename || '').trim();
    if (!rawFilename) return '[Error creating document]: filename is required';
    if (path.isAbsolute(rawFilename)) {
      return '[Error creating document]: absolute paths are not allowed for create_document. Use file_write for explicit absolute paths.';
    }

    const filePath = path.join(normalizeFsPath(dir), rawFilename);

    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    // Text-native formats — direct file write
    if (['md', 'txt', 'html'].includes(format)) {
      fs.writeFileSync(filePath, content || '', 'utf-8');
      return `[Created ${filePath}]`;
    }

    if (format === 'json') {
      fs.writeFileSync(filePath, JSON.stringify(structured_data || content || {}, null, 2), 'utf-8');
      return `[Created ${filePath}]`;
    }

    if (format === 'csv') {
      const data = structured_data || [];
      if (data.length > 0) {
        const headers = Object.keys(data[0]);
        const rows = [headers.join(','), ...data.map((row: any) => headers.map(h => `"${String(row[h] ?? '').replace(/"/g, '""')}"`).join(','))];
        fs.writeFileSync(filePath, rows.join('\n'), 'utf-8');
      } else {
        fs.writeFileSync(filePath, content || '', 'utf-8');
      }
      return `[Created ${filePath}]`;
    }

    // Binary formats — generate via Python
    if (format === 'docx') {
      return await generateDocx(filePath, content || '');
    }

    if (format === 'pdf') {
      return await generatePdf(filePath, content || '');
    }

    if (format === 'xlsx') {
      return await generateXlsx(filePath, content || '', structured_data);
    }

    // Unknown format — honest error instead of silent plain-text write
    return `[Error] Unsupported format: "${format}". Supported: md, txt, html, json, csv, docx, pdf, xlsx.`;
  } catch (err: any) {
    return `[Error creating document]: ${err.message}`;
  }
}

export async function executeMemorySearch(input: Record<string, any>): Promise<string> {
  const { query, limit = 5 } = input;

  try {
    const results = searchMemory(query, limit);
    if (results.length === 0) {
      return `No memories found matching "${query}".`;
    }

    const lines = results.map((r: MemoryEntry) =>
      `[${r.category}] ${r.key}: ${r.value} (confidence: ${r.confidence})`
    );
    return `Found ${results.length} memories:\n${lines.join('\n')}`;
  } catch (err: any) {
    return `[Error searching memory]: ${err.message}`;
  }
}

export async function executeMemoryStore(input: Record<string, any>): Promise<string> {
  const { category, key, value } = input;

  try {
    remember(category, key, value, 'user');
    return `Remembered: [${category}] ${key} = ${value}`;
  } catch (err: any) {
    return `[Error storing memory]: ${err.message}`;
  }
}

export async function executeRecallContext(input: Record<string, any>): Promise<string> {
  const { query, limit = 3 } = input;

  try {
    const exchanges = searchPastConversations(query, null, limit);
    if (exchanges.length === 0) {
      return `No past conversations found matching "${query}".`;
    }

    const lines: string[] = [`Found ${exchanges.length} relevant exchange(s):`];
    for (const ex of exchanges) {
      lines.push('');
      lines.push(`── ${ex.conversationTitle} (${new Date(ex.timestamp).toLocaleDateString()}) ──`);
      lines.push(`User asked: ${ex.userMessage}`);
      lines.push(`Assistant answered: ${ex.assistantResponse}`);
    }
    return lines.join('\n');
  } catch (err: any) {
    return `[Error searching past conversations]: ${err.message}`;
  }
}
