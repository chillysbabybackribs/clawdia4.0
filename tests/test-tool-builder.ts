/**
 * Tool Builder Tests — Verifies tool group composition, filtering, dispatch map.
 *
 * Run:  npx tsx tests/test-tool-builder.ts
 */

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string): void {
  if (condition) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ❌ ${label}`); }
}
function section(name: string): void { console.log(`\n━━━ ${name} ━━━`); }
function assertEq<T>(actual: T, expected: T, label: string): void {
  assert(actual === expected, `${label} (got: ${actual}, expected: ${expected})`);
}

import { getToolsForGroup, filterTools, isKnownTool } from '../src/main/agent/tool-builder';

// ════════════════════════════════════════════════════════
// TOOL GROUP COMPOSITION
// ════════════════════════════════════════════════════════

section('getToolsForGroup — core');
{
  const tools = getToolsForGroup('core');
  const names = tools.map(t => t.name);
  assert(names.includes('shell_exec'), 'Core has shell_exec');
  assert(names.includes('file_read'), 'Core has file_read');
  assert(names.includes('file_write'), 'Core has file_write');
  assert(names.includes('file_edit'), 'Core has file_edit');
  assert(names.includes('directory_tree'), 'Core has directory_tree');
  assert(names.includes('fs_quote_lookup'), 'Core has fs_quote_lookup');
  assert(names.includes('fs_folder_summary'), 'Core has fs_folder_summary');
  assert(names.includes('fs_reorg_plan'), 'Core has fs_reorg_plan');
  assert(names.includes('fs_duplicate_scan'), 'Core has fs_duplicate_scan');
  assert(names.includes('fs_apply_plan'), 'Core has fs_apply_plan');
  assert(!names.includes('browser_search'), 'Core does NOT have browser_search');
  assert(!names.includes('gui_interact'), 'Core does NOT have gui_interact');
  assertEq(tools.length, 10, 'Core has exactly 10 tools');
}

section('getToolsForGroup — browser');
{
  const tools = getToolsForGroup('browser');
  const names = tools.map(t => t.name);
  assert(names.includes('browser_search'), 'Browser has browser_search');
  assert(names.includes('browser_navigate'), 'Browser has browser_navigate');
  assert(names.includes('browser_click'), 'Browser has browser_click');
  assert(names.includes('browser_type'), 'Browser has browser_type');
  assert(names.includes('browser_extract'), 'Browser has browser_extract');
  assert(names.includes('browser_screenshot'), 'Browser has browser_screenshot');
  assert(names.includes('browser_scroll'), 'Browser has browser_scroll');
  assert(names.includes('browser_read_page'), 'Browser has browser_read_page');
  assert(!names.includes('shell_exec'), 'Browser does NOT have shell_exec');
  assert(!names.includes('gui_interact'), 'Browser does NOT have gui_interact');
  assertEq(tools.length, 8, 'Browser has exactly 8 tools');
}

section('getToolsForGroup — full');
{
  const tools = getToolsForGroup('full');
  const names = tools.map(t => t.name);
  // Should have core + browser + extra
  assert(names.includes('shell_exec'), 'Full has shell_exec (from core)');
  assert(names.includes('file_read'), 'Full has file_read (from core)');
  assert(names.includes('browser_search'), 'Full has browser_search (from browser)');
  assert(names.includes('browser_navigate'), 'Full has browser_navigate (from browser)');
  assert(names.includes('gui_interact'), 'Full has gui_interact (from extra)');
  assert(names.includes('app_control'), 'Full has app_control (from extra)');
  assert(names.includes('dbus_control'), 'Full has dbus_control (from extra)');
  assert(names.includes('create_document'), 'Full has create_document (from extra)');
  assert(names.includes('memory_search'), 'Full has memory_search (from extra)');
  assert(names.includes('memory_store'), 'Full has memory_store (from extra)');
  assert(names.includes('recall_context'), 'Full has recall_context (from extra)');
  assert(tools.length > 15, `Full has many tools (got ${tools.length})`);
}

section('getToolsForGroup — no duplicates');
{
  const tools = getToolsForGroup('full');
  const names = tools.map(t => t.name);
  const unique = new Set(names);
  assertEq(names.length, unique.size, 'No duplicate tool names in full group');
}

// ════════════════════════════════════════════════════════
// TOOL FILTERING
// ════════════════════════════════════════════════════════

section('filterTools — empty disallowed list');
{
  const tools = getToolsForGroup('full');
  const filtered = filterTools(tools, []);
  assertEq(filtered.length, tools.length, 'No change with empty disallowed');
}

section('filterTools — remove gui_interact and app_control');
{
  const tools = getToolsForGroup('full');
  const filtered = filterTools(tools, ['gui_interact', 'app_control', 'dbus_control']);
  const names = filtered.map(t => t.name);
  assert(!names.includes('gui_interact'), 'gui_interact removed');
  assert(!names.includes('app_control'), 'app_control removed');
  assert(!names.includes('dbus_control'), 'dbus_control removed');
  assert(names.includes('shell_exec'), 'shell_exec still present');
  assert(names.includes('browser_search'), 'browser_search still present');
  assertEq(filtered.length, tools.length - 3, 'Exactly 3 tools removed');
}

section('filterTools — remove non-existent tool');
{
  const tools = getToolsForGroup('core');
  const filtered = filterTools(tools, ['nonexistent_tool']);
  assertEq(filtered.length, tools.length, 'No change when removing non-existent');
}

// ════════════════════════════════════════════════════════
// KNOWN TOOL CHECK
// ════════════════════════════════════════════════════════

section('isKnownTool');
{
  assert(isKnownTool('shell_exec'), 'shell_exec is known (streaming)');
  assert(isKnownTool('file_read'), 'file_read is known');
  assert(isKnownTool('browser_search'), 'browser_search is known');
  assert(isKnownTool('gui_interact'), 'gui_interact is known');
  assert(isKnownTool('app_control'), 'app_control is known');
  assert(isKnownTool('dbus_control'), 'dbus_control is known');
  assert(isKnownTool('memory_search'), 'memory_search is known');
  assert(isKnownTool('fs_quote_lookup'), 'fs_quote_lookup is known');
  assert(isKnownTool('fs_folder_summary'), 'fs_folder_summary is known');
  assert(isKnownTool('fs_reorg_plan'), 'fs_reorg_plan is known');
  assert(isKnownTool('fs_duplicate_scan'), 'fs_duplicate_scan is known');
  assert(isKnownTool('fs_apply_plan'), 'fs_apply_plan is known');
  assert(!isKnownTool('hallucinated_tool'), 'hallucinated_tool is NOT known');
  assert(!isKnownTool(''), 'empty string is NOT known');
}

// ════════════════════════════════════════════════════════
// TOOL SCHEMA VALIDATION
// ════════════════════════════════════════════════════════

section('Tool schemas — all have required fields');
{
  const tools = getToolsForGroup('full');
  for (const tool of tools) {
    assert(typeof tool.name === 'string' && tool.name.length > 0, `${tool.name}: has name`);
    assert(typeof tool.description === 'string' && tool.description.length > 10, `${tool.name}: has description (>10 chars)`);
    assert(tool.input_schema !== undefined, `${tool.name}: has input_schema`);
    assert(tool.input_schema.type === 'object', `${tool.name}: schema type is object`);
  }
}

section('Tool schemas — shell_exec has command param');
{
  const tools = getToolsForGroup('core');
  const shellExec = tools.find(t => t.name === 'shell_exec')!;
  const props = (shellExec.input_schema as any).properties;
  assert(props.command !== undefined, 'shell_exec has command property');
  assertEq(props.command.type, 'string', 'command is string type');
  assert((shellExec.input_schema as any).required.includes('command'), 'command is required');
}

section('Tool schemas — gui_interact has action enum');
{
  const tools = getToolsForGroup('full');
  const gui = tools.find(t => t.name === 'gui_interact')!;
  const props = (gui.input_schema as any).properties;
  assert(props.action !== undefined, 'gui_interact has action property');
  assert(Array.isArray(props.action.enum), 'action has enum values');
  assert(props.action.enum.includes('click'), 'action enum includes click');
  assert(props.action.enum.includes('type'), 'action enum includes type');
  assert(props.action.enum.includes('batch_actions'), 'action enum includes batch_actions');
  assert(props.action.enum.includes('a11y_get_tree'), 'action enum includes a11y_get_tree');
  assert(props.action.enum.includes('launch_and_focus'), 'action enum includes launch_and_focus');
}

// ════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ❌ ${f}`);
  process.exit(1);
}
console.log('\n🎉 All tool builder tests passed!');
