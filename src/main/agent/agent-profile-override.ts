import type { AgentProfile } from '../../shared/types';
import type { TaskProfile } from './classifier';

const SLASH_PROFILE_MAP: Record<string, AgentProfile> = {
  '/filesystem-agent': 'filesystem',
  '/general-agent': 'general',
  '/bloodhound': 'bloodhound',
  '/extractor': 'ytdlp',
};

export function parseManualAgentProfileOverride(message: string): {
  cleanedMessage: string;
  forcedAgentProfile?: AgentProfile;
} {
  const trimmed = message.trim();
  if (!trimmed.startsWith('/')) return { cleanedMessage: message };

  const [command, ...rest] = trimmed.split(/\s+/);
  const forcedAgentProfile = SLASH_PROFILE_MAP[command.toLowerCase()];
  if (!forcedAgentProfile) return { cleanedMessage: message };

  return {
    cleanedMessage: rest.join(' ').trim(),
    forcedAgentProfile,
  };
}

export function applyAgentProfileOverride(
  baseProfile: TaskProfile,
  forcedAgentProfile?: AgentProfile,
): TaskProfile {
  if (!forcedAgentProfile || forcedAgentProfile === baseProfile.agentProfile) return baseProfile;

  const promptModules = new Set(baseProfile.promptModules);

  if (forcedAgentProfile === 'filesystem') {
    promptModules.add('filesystem');
    promptModules.delete('bloodhound');
    return {
      ...baseProfile,
      agentProfile: 'filesystem',
      toolGroup: 'core',
      promptModules,
      model: baseProfile.model === 'haiku' ? 'sonnet' : baseProfile.model,
      isGreeting: false,
    };
  }

  if (forcedAgentProfile === 'bloodhound') {
    promptModules.add('bloodhound');
    promptModules.add('browser');
    promptModules.delete('filesystem');
    return {
      ...baseProfile,
      agentProfile: 'bloodhound',
      toolGroup: baseProfile.toolGroup === 'core' ? 'browser' : baseProfile.toolGroup,
      promptModules,
      model: 'sonnet',
      isGreeting: false,
    };
  }

  if (forcedAgentProfile === 'ytdlp') {
    promptModules.add('browser');
    promptModules.delete('filesystem');
    promptModules.delete('bloodhound');
    return {
      ...baseProfile,
      agentProfile: 'ytdlp',
      toolGroup: 'browser',
      promptModules,
      model: 'sonnet',
      isGreeting: false,
    };
  }

  promptModules.delete('filesystem');
  return {
    ...baseProfile,
    agentProfile: 'general',
    promptModules,
    isGreeting: false,
  };
}
