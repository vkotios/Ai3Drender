import { env } from '@/lib/env';

import { FalProvider } from './fal';
import { MeshyProvider } from './meshy';
import { StubMeshProvider } from './stub';
import { TripoProvider } from './tripo';
import type { MeshProvider } from './types';

export type { MeshProvider, ReconstructionInput, ReconstructionResult } from './types';
export { MeshProviderError } from './types';
export { buildMassing, buildMassingGlb } from './massing';

const PROVIDERS: Record<string, () => MeshProvider> = {
  stub: () => new StubMeshProvider(),
  meshy: () => new MeshyProvider(),
  tripo: () => new TripoProvider(),
  fal: () => new FalProvider(),
};

/**
 * Resolve the configured reconstruction vendor.
 *
 * A vendor named but missing its key falls back to the stub rather than failing
 * the job, and says so in the returned provider name, so a misconfigured deploy
 * degrades to block models instead of dead-ending every asset.
 */
export function getMeshProvider(): MeshProvider {
  const factory = PROVIDERS[env.meshProvider];
  if (!factory) {
    console.warn(`Unknown MESH_PROVIDER "${env.meshProvider}"; falling back to stub.`);
    return new StubMeshProvider();
  }
  const provider = factory();
  if (!provider.configured) {
    console.warn(`MESH_PROVIDER is "${provider.name}" but its API key is unset; using stub.`);
    return new StubMeshProvider();
  }
  return provider;
}

export function listProviders(): { name: string; configured: boolean; active: boolean }[] {
  const active = getMeshProvider().name;
  return Object.entries(PROVIDERS).map(([name, factory]) => {
    const provider = factory();
    return { name, configured: provider.configured, active: name === active };
  });
}
