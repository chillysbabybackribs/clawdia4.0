/**
 * AccountProvisioner — orchestrates the full account signup flow.
 *
 * Usage:
 *   const result = await provisioner.ensureAccount('reddit', { loginUrl, signupFn });
 *   if (result.status === 'existing' || result.status === 'provisioned') {
 *     // proceed with task using result.account
 *   } else if (result.status === 'needs_human') {
 *     // pause and request human intervention
 *   }
 */
import type { ManagedAccount } from './identity-store';
import type { IdentityStore } from './identity-store';

// ─── InterventionNeeded ───────────────────────────────────────────────────────

export class InterventionNeeded extends Error {
  constructor(
    public readonly interventionType: 'captcha' | 'phone_required' | 'unexpected_form',
    public readonly userMessage: string,
  ) {
    super(userMessage);
    this.name = 'InterventionNeeded';
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SignupResult {
  username: string;
  password: string;
  email: string;
  phoneUsed?: string;
  phoneMethod?: string;
}

export interface EnsureAccountOptions {
  loginUrl?: string;
  /** Called when no account exists. Should navigate signup form and return credentials used. */
  signupFn?: (profile: { fullName: string; email: string; usernamePattern: string }) => Promise<SignupResult>;
  /** Override identity profile name. Defaults to 'default'. */
  identityProfileName?: string;
}

export type EnsureAccountResult =
  | { status: 'existing'; account: ManagedAccount }
  | { status: 'provisioned'; account: ManagedAccount }
  | { status: 'needs_human'; interventionType: 'captcha' | 'phone_required' | 'unexpected_form'; message: string }
  | { status: 'failed'; error: string };

// ─── AccountProvisioner ───────────────────────────────────────────────────────

export class AccountProvisioner {
  constructor(private readonly store: IdentityStore) {}

  async ensureAccount(serviceName: string, opts: EnsureAccountOptions = {}): Promise<EnsureAccountResult> {
    // 1. Check registry
    const existing = this.store.getAccount(serviceName);
    if (existing && existing.status === 'active') {
      return { status: 'existing', account: existing };
    }

    // 2. No active account — provision
    console.log(`[Autonomy] No active account for ${serviceName} — provisioning`);

    const profileName = opts.identityProfileName ?? 'default';
    const profile = this.store.getProfileByName(profileName) ?? this.store.getDefaultProfile();
    const identityInput = {
      fullName: profile?.fullName ?? '',
      email: profile?.email ?? '',
      usernamePattern: profile?.usernamePattern ?? '',
    };

    try {
      if (!opts.signupFn) {
        return { status: 'failed', error: `No signup function provided for ${serviceName}` };
      }

      // 3. Run signup (may throw InterventionNeeded)
      const signupResult = await opts.signupFn(identityInput);

      // 4. Save to registry
      const account = this.store.saveAccount({
        serviceName,
        loginUrl: opts.loginUrl ?? '',
        username: signupResult.username,
        emailUsed: signupResult.email,
        passwordPlain: signupResult.password,
        phoneUsed: signupResult.phoneUsed ?? '',
        phoneMethod: signupResult.phoneMethod ?? '',
        identityProfileId: profile?.id,
        status: 'active',
      });

      console.log(`[Autonomy] Account provisioned for ${serviceName}: ${signupResult.username}`);
      return { status: 'provisioned', account };

    } catch (err) {
      if (err instanceof InterventionNeeded) {
        console.log(`[Autonomy] Human intervention needed for ${serviceName}: ${err.interventionType}`);
        return { status: 'needs_human', interventionType: err.interventionType, message: err.userMessage };
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Autonomy] Signup failed for ${serviceName}: ${msg}`);
      return { status: 'failed', error: msg };
    }
  }
}
