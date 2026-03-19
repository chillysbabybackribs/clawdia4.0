#!/usr/bin/env python3
"""
AT-SPI Accessibility Bridge — V1
Provides structured access to desktop application UI trees via Linux AT-SPI.

Operations:
  get_tree     — Compact tree snapshot for a target app/window/dialog
  find         — Find a single element by role + name within a scope
  do_action    — Execute a semantic action (click, activate, press, toggle)
  set_value    — Set text/value on an entry-like control
  get_state    — Read back state/value of an element

Usage:
  python3 a11y-bridge.py get_tree --app gimp
  python3 a11y-bridge.py get_tree --app gimp --scope "Scale Image"
  python3 a11y-bridge.py find --app gimp --role "push button" --name "OK"
  python3 a11y-bridge.py do_action --app gimp --role "push button" --name "OK" --action click
  python3 a11y-bridge.py set_value --app gimp --role "spin button" --name "Width" --value "800"
  python3 a11y-bridge.py get_state --app gimp --role "spin button" --name "Width"

Output: JSON to stdout. Diagnostics to stderr.

Requires: gir1.2-atspi-2.0
  Install: sudo apt install gir1.2-atspi-2.0
"""

import json
import sys
import argparse
import time

try:
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi
except (ValueError, ImportError) as e:
    print(json.dumps({
        'error': f'AT-SPI not available: {e}',
        'install': 'sudo apt install gir1.2-atspi-2.0',
    }))
    sys.exit(1)

# Initialize AT-SPI
Atspi.init()

# ═══════════════════════════════════
# Constants
# ═══════════════════════════════════

MAX_TREE_DEPTH = 6          # Don't recurse deeper than this for get_tree
MAX_CHILDREN_SHOWN = 30     # Cap children per node in tree output
MAX_FIND_RESULTS = 50       # Stop searching after this many candidates
MATCH_TIMEOUT_MS = 2000     # Max time for find/action operations

# Roles we care about for V1 (readable names)
V1_ROLES = {
    'push button', 'toggle button', 'check box', 'radio button',
    'menu', 'menu bar', 'menu item', 'check menu item', 'radio menu item',
    'text', 'password text', 'spin button', 'combo box', 'entry',
    'dialog', 'alert', 'file chooser',
    'label', 'status bar', 'tool bar', 'page tab', 'page tab list',
    'frame', 'panel', 'scroll pane', 'filler',
    'table', 'table cell', 'tree', 'tree item', 'list', 'list item',
}

# Actions we support in V1
V1_ACTIONS = {'click', 'activate', 'press', 'toggle'}


# ═══════════════════════════════════
# Helpers
# ═══════════════════════════════════

def get_role_name(node) -> str:
    """Get human-readable role name."""
    try:
        return node.get_role_name()
    except Exception:
        return 'unknown'


def get_name(node) -> str:
    """Get accessible name."""
    try:
        return node.get_name() or ''
    except Exception:
        return ''


def get_description(node) -> str:
    """Get accessible description."""
    try:
        return node.get_description() or ''
    except Exception:
        return ''


def get_states(node) -> list[str]:
    """Get state names for a node."""
    try:
        state_set = node.get_state_set()
        states = []
        # Check common states
        for state in [
            Atspi.StateType.FOCUSED, Atspi.StateType.SELECTED,
            Atspi.StateType.CHECKED, Atspi.StateType.ENABLED,
            Atspi.StateType.SENSITIVE, Atspi.StateType.VISIBLE,
            Atspi.StateType.SHOWING, Atspi.StateType.EDITABLE,
            Atspi.StateType.ACTIVE, Atspi.StateType.MODAL,
            Atspi.StateType.EXPANDED, Atspi.StateType.FOCUSABLE,
        ]:
            if state_set.contains(state):
                states.append(Atspi.StateType.get_name(state))
        return states
    except Exception:
        return []


def get_value(node) -> str | None:
    """Get text or numeric value if available."""
    try:
        # Try text interface first
        ti = node.get_text_iface()
        if ti:
            text = ti.get_text(0, ti.get_character_count())
            if text:
                return text
    except Exception:
        pass
    try:
        # Try value interface
        vi = node.get_value_iface()
        if vi:
            return str(vi.get_current_value())
    except Exception:
        pass
    return None


def get_actions(node) -> list[str]:
    """Get available action names."""
    try:
        ai = node.get_action_iface()
        if not ai:
            return []
        count = ai.get_n_actions()
        return [ai.get_action_name(i) for i in range(count)]
    except Exception:
        return []


def child_count(node) -> int:
    """Safe child count."""
    try:
        return node.get_child_count()
    except Exception:
        return 0


def get_child(node, index):
    """Safe child access."""
    try:
        return node.get_child_at_index(index)
    except Exception:
        return None


# ═══════════════════════════════════
# App/Window Discovery
# ═══════════════════════════════════

def find_app(app_name: str):
    """Find a running application by name (case-insensitive substring match)."""
    desktop = Atspi.get_desktop(0)
    app_lower = app_name.lower()
    best = None
    best_score = 0

    for i in range(desktop.get_child_count()):
        app = get_child(desktop, i)
        if not app:
            continue
        name = get_name(app).lower()
        if not name:
            continue

        # Exact match
        if name == app_lower:
            return app
        # Substring match — prefer shorter names (more specific)
        if app_lower in name or name in app_lower:
            score = 100 - abs(len(name) - len(app_lower))
            if score > best_score:
                best = app
                best_score = score

    return best


def find_scope(app_node, scope_name: str):
    """Find a dialog/window within an app by name (case-insensitive)."""
    if not scope_name:
        return app_node

    scope_lower = scope_name.lower()

    def search(node, depth=0):
        if depth > 4:
            return None
        name = get_name(node).lower()
        role = get_role_name(node)

        # Match scope by name on dialog/frame/window roles
        if role in ('dialog', 'alert', 'file chooser', 'frame'):
            if scope_lower in name or name in scope_lower:
                return node

        for i in range(min(child_count(node), 50)):
            child = get_child(node, i)
            if child:
                result = search(child, depth + 1)
                if result:
                    return result
        return None

    return search(app_node)


# ═══════════════════════════════════
# Operations
# ═══════════════════════════════════

def op_get_tree(app_name: str, scope: str | None = None, max_depth: int = MAX_TREE_DEPTH):
    """Get a compact tree snapshot."""
    app = find_app(app_name)
    if not app:
        return {'error': f'App "{app_name}" not found in AT-SPI tree', 'available_apps': list_apps()}

    root = find_scope(app, scope) if scope else app
    if not root:
        return {'error': f'Scope "{scope}" not found in "{app_name}"'}

    def build_tree(node, depth=0):
        if depth > max_depth:
            return None

        role = get_role_name(node)
        name = get_name(node)
        n_children = child_count(node)

        # Skip invisible/non-showing nodes to keep tree compact
        states = get_states(node)
        if depth > 1 and 'showing' not in states and 'visible' not in states:
            return None

        entry = {'role': role}
        if name:
            entry['name'] = name
        desc = get_description(node)
        if desc:
            entry['description'] = desc

        # Include value for editable/entry-like controls
        if role in ('text', 'entry', 'spin button', 'password text', 'combo box'):
            val = get_value(node)
            if val is not None:
                entry['value'] = val[:100]

        # Include states that matter (skip verbose ones)
        useful_states = [s for s in states if s in (
            'focused', 'selected', 'checked', 'active', 'modal',
            'expanded', 'editable',
        )]
        if useful_states:
            entry['states'] = useful_states

        # Include actions for actionable controls
        if role in ('push button', 'toggle button', 'check box', 'radio button',
                     'menu item', 'check menu item', 'radio menu item'):
            actions = get_actions(node)
            if actions:
                entry['actions'] = actions

        # Recurse children
        if n_children > 0 and depth < max_depth:
            children = []
            for i in range(min(n_children, MAX_CHILDREN_SHOWN)):
                child = get_child(node, i)
                if child:
                    child_tree = build_tree(child, depth + 1)
                    if child_tree:
                        children.append(child_tree)
            if children:
                entry['children'] = children
            elif n_children > 0:
                entry['childCount'] = n_children

        return entry

    tree = build_tree(root)
    return {
        'app': get_name(app),
        'scope': scope or get_name(root),
        'tree': tree,
    }


def op_find(app_name: str, role: str, name: str, scope: str | None = None):
    """Find a single element by role + name."""
    app = find_app(app_name)
    if not app:
        return {'error': f'App "{app_name}" not found', 'available_apps': list_apps()}

    root = find_scope(app, scope) if scope else app
    if scope and not root:
        return {'error': f'Scope "{scope}" not found in "{app_name}"'}

    role_lower = role.lower()
    name_lower = name.lower()
    matches = []

    def search(node, path='', depth=0):
        if depth > 8 or len(matches) >= MAX_FIND_RESULTS:
            return
        n_role = get_role_name(node).lower()
        n_name = get_name(node).lower()

        if n_role == role_lower:
            # Exact name match
            if n_name == name_lower:
                matches.append({
                    'path': path, 'role': n_role, 'name': get_name(node),
                    'match': 'exact', 'value': get_value(node),
                    'actions': get_actions(node), 'states': get_states(node),
                    '_node': node,
                })
            # Partial name match
            elif name_lower in n_name or n_name in name_lower:
                matches.append({
                    'path': path, 'role': n_role, 'name': get_name(node),
                    'match': 'partial', 'value': get_value(node),
                    'actions': get_actions(node), 'states': get_states(node),
                    '_node': node,
                })

        for i in range(min(child_count(node), 100)):
            child = get_child(node, i)
            if child:
                child_name = get_name(child) or f'[{i}]'
                search(child, f'{path}/{child_name}', depth + 1)

    search(root)

    # Rank: exact > partial, then by depth (shorter path = better)
    exact = [m for m in matches if m['match'] == 'exact']
    partial = [m for m in matches if m['match'] == 'partial']
    ranked = exact + partial

    # Strip internal _node from output
    result_matches = []
    for m in ranked[:5]:
        out = {k: v for k, v in m.items() if k != '_node'}
        result_matches.append(out)

    if len(ranked) == 0:
        return {'found': False, 'error': f'No element with role="{role}" name="{name}" found'}
    elif len(ranked) == 1:
        return {'found': True, 'match': result_matches[0], 'ambiguous': False}
    else:
        return {
            'found': True,
            'match': result_matches[0],
            'ambiguous': len(exact) != 1,
            'candidates': len(ranked),
            'top_matches': result_matches,
        }


def op_do_action(app_name: str, role: str, name: str, action: str, scope: str | None = None):
    """Execute a semantic action on a matched element."""
    if action.lower() not in V1_ACTIONS:
        return {'error': f'Unsupported action "{action}". V1 supports: {sorted(V1_ACTIONS)}'}

    find_result = op_find(app_name, role, name, scope)
    if not find_result.get('found'):
        return find_result

    if find_result.get('ambiguous'):
        return {
            'error': 'Ambiguous match — refusing to act. Narrow your search or add scope.',
            'candidates': find_result.get('top_matches', []),
        }

    # Re-find the actual node (op_find strips it for JSON output)
    app = find_app(app_name)
    root = find_scope(app, scope) if scope else app
    node = _find_node(root, role.lower(), name.lower())
    if not node:
        return {'error': 'Element found in search but could not be re-located for action'}

    # Get action interface
    ai = node.get_action_iface()
    if not ai:
        return {'error': f'Element has no action interface', 'element': {'role': role, 'name': name}}

    # Find the requested action
    action_lower = action.lower()
    n_actions = ai.get_n_actions()
    action_index = -1
    for i in range(n_actions):
        if ai.get_action_name(i).lower() == action_lower:
            action_index = i
            break

    # Fallback: 'click' often maps to index 0
    if action_index == -1 and action_lower == 'click' and n_actions > 0:
        action_index = 0
        print(f'[a11y] No explicit "click" action, using action[0]: "{ai.get_action_name(0)}"', file=sys.stderr)

    if action_index == -1:
        available = [ai.get_action_name(i) for i in range(n_actions)]
        return {'error': f'Action "{action}" not available', 'available_actions': available}

    # Execute
    success = ai.do_action(action_index)
    return {
        'success': success,
        'action': action,
        'element': {'role': role, 'name': name},
    }


def op_set_value(app_name: str, role: str, name: str, value: str, scope: str | None = None):
    """Set text/value on an entry-like control."""
    app = find_app(app_name)
    if not app:
        return {'error': f'App "{app_name}" not found'}

    root = find_scope(app, scope) if scope else app
    node = _find_node(root, role.lower(), name.lower())
    if not node:
        return {'error': f'Element role="{role}" name="{name}" not found'}

    # Try text interface (for text entries)
    try:
        ei = node.get_editable_text_iface()
        if ei:
            # Clear existing text
            ti = node.get_text_iface()
            if ti:
                length = ti.get_character_count()
                if length > 0:
                    ei.delete_text(0, length)
            # Insert new text
            ei.insert_text(0, value, len(value))
            # Read back
            new_val = get_value(node)
            return {
                'success': True,
                'element': {'role': role, 'name': name},
                'value_set': value,
                'value_read_back': new_val,
            }
    except Exception as e:
        print(f'[a11y] EditableText failed: {e}', file=sys.stderr)

    # Try value interface (for spin buttons, sliders)
    try:
        vi = node.get_value_iface()
        if vi:
            vi.set_current_value(float(value))
            new_val = vi.get_current_value()
            return {
                'success': True,
                'element': {'role': role, 'name': name},
                'value_set': value,
                'value_read_back': str(new_val),
            }
    except Exception as e:
        print(f'[a11y] Value interface failed: {e}', file=sys.stderr)

    return {'error': f'Could not set value on element (no EditableText or Value interface)'}


def op_get_state(app_name: str, role: str, name: str, scope: str | None = None):
    """Read state/value of an element."""
    app = find_app(app_name)
    if not app:
        return {'error': f'App "{app_name}" not found'}

    root = find_scope(app, scope) if scope else app
    node = _find_node(root, role.lower(), name.lower())
    if not node:
        return {'error': f'Element role="{role}" name="{name}" not found'}

    return {
        'role': get_role_name(node),
        'name': get_name(node),
        'value': get_value(node),
        'states': get_states(node),
        'actions': get_actions(node),
    }


# ═══════════════════════════════════
# Internal helpers
# ═══════════════════════════════════

def _find_node(root, role_lower: str, name_lower: str, depth=0):
    """Internal: find first exact-then-partial match node (returns the node, not JSON)."""
    if depth > 8:
        return None

    n_role = get_role_name(root).lower()
    n_name = get_name(root).lower()

    if n_role == role_lower and (n_name == name_lower or name_lower in n_name):
        return root

    for i in range(min(child_count(root), 100)):
        child = get_child(root, i)
        if child:
            result = _find_node(child, role_lower, name_lower, depth + 1)
            if result:
                return result
    return None


def list_apps() -> list[str]:
    """List running apps visible to AT-SPI."""
    desktop = Atspi.get_desktop(0)
    apps = []
    for i in range(desktop.get_child_count()):
        app = get_child(desktop, i)
        if app:
            name = get_name(app)
            if name:
                apps.append(name)
    return sorted(apps)


# ═══════════════════════════════════
# CLI
# ═══════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description='AT-SPI Accessibility Bridge V1')
    parser.add_argument('operation', choices=['get_tree', 'find', 'do_action', 'set_value', 'get_state', 'list_apps'])
    parser.add_argument('--app', required=False, help='Application name')
    parser.add_argument('--scope', required=False, help='Dialog/window name to scope into')
    parser.add_argument('--role', required=False, help='Element role (e.g. "push button", "spin button")')
    parser.add_argument('--name', required=False, help='Element name')
    parser.add_argument('--action', required=False, help='Action to perform (click, activate, press, toggle)')
    parser.add_argument('--value', required=False, help='Value to set')
    parser.add_argument('--depth', type=int, default=MAX_TREE_DEPTH, help='Max tree depth for get_tree')

    args = parser.parse_args()

    if args.operation == 'list_apps':
        result = {'apps': list_apps()}
    elif args.operation == 'get_tree':
        if not args.app:
            result = {'error': '--app is required for get_tree'}
        else:
            result = op_get_tree(args.app, args.scope, args.depth)
    elif args.operation == 'find':
        if not args.app or not args.role or not args.name:
            result = {'error': '--app, --role, and --name are required for find'}
        else:
            result = op_find(args.app, args.role, args.name, args.scope)
    elif args.operation == 'do_action':
        if not args.app or not args.role or not args.name or not args.action:
            result = {'error': '--app, --role, --name, and --action are required'}
        else:
            result = op_do_action(args.app, args.role, args.name, args.action, args.scope)
    elif args.operation == 'set_value':
        if not args.app or not args.role or not args.name or not args.value:
            result = {'error': '--app, --role, --name, and --value are required'}
        else:
            result = op_set_value(args.app, args.role, args.name, args.value, args.scope)
    elif args.operation == 'get_state':
        if not args.app or not args.role or not args.name:
            result = {'error': '--app, --role, and --name are required'}
        else:
            result = op_get_state(args.app, args.role, args.name, args.scope)
    else:
        result = {'error': f'Unknown operation: {args.operation}'}

    print(json.dumps(result, indent=2, default=str))


if __name__ == '__main__':
    main()
