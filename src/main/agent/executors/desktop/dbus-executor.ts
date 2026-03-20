import { run, cmdExists } from './shared';

export async function executeDbusControl(input: Record<string, any>): Promise<string> {
  const { action, service, path: objPath, interface: iface, method, args = [] } = input;
  if (!action) return '[Error] action is required.';
  if (!await cmdExists('dbus-send')) return '[Error] dbus-send not found.';

  switch (action) {
    case 'list_running': {
      const raw = await run(`dbus-send --session --dest=org.freedesktop.DBus --type=method_call --print-reply /org/freedesktop/DBus org.freedesktop.DBus.ListNames`);
      const lines = raw.split('\n').filter(l => l.includes('string "')).map(l => l.match(/string "(.+)"/)?.[1])
        .filter((s): s is string => !!s && !s.startsWith(':') && !s.startsWith('org.freedesktop.') && s.includes('.')).sort();
      if (lines.length === 0) return 'No interesting DBus services found.';
      return `Active DBus services (${lines.length}):\n${lines.map(s => `  ${s}`).join('\n')}`;
    }
    case 'discover': {
      if (!service) return '[Error] service name required.';
      const path = objPath || '/';
      const result = await run(`dbus-send --session --dest=${service} --type=method_call --print-reply ${path} org.freedesktop.DBus.Introspectable.Introspect`);
      const xmlMatch = result.match(/<node[\s\S]*<\/node>/);
      if (xmlMatch) {
        const ifaces = xmlMatch[0].match(/<interface name="([^"]+)">/g)?.map(m => m.match(/name="([^"]+)"/)?.[1]).filter((s): s is string => !!s && !s.startsWith('org.freedesktop.DBus.')) || [];
        const methods = xmlMatch[0].match(/<method name="([^"]+)">/g)?.map(m => m.match(/name="([^"]+)"/)?.[1]).filter(Boolean) || [];
        const props = xmlMatch[0].match(/<property name="([^"]+)"/g)?.map(m => m.match(/name="([^"]+)"/)?.[1]).filter(Boolean) || [];
        let s = `Service: ${service}\nPath: ${path}\n`;
        if (ifaces.length) s += `\nInterfaces:\n${ifaces.map(i => `  ${i}`).join('\n')}`;
        if (methods.length) s += `\nMethods:\n${methods.map(m => `  ${m}()`).join('\n')}`;
        if (props.length) s += `\nProperties:\n${props.map(p => `  ${p}`).join('\n')}`;
        return s;
      }
      return result;
    }
    case 'call': {
      if (!service || !objPath || !iface || !method) return '[Error] service, path, interface, method required.';
      const argsStr = (args as string[]).map(a => `string:"${a}"`).join(' ');
      return await run(`dbus-send --session --dest=${service} --type=method_call --print-reply ${objPath} ${iface}.${method} ${argsStr}`);
    }
    case 'get_property': {
      if (!service || !objPath || !iface || !method) return '[Error] service, path, interface, property required.';
      return await run(`dbus-send --session --dest=${service} --type=method_call --print-reply ${objPath} org.freedesktop.DBus.Properties.Get string:"${iface}" string:"${method}"`);
    }
    default: return `[Error] Unknown action: "${action}".`;
  }
}
