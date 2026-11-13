// Key material for the encrypted runtime configuration in D1.
//
// Rotation: bind the new secret as WORKOHOLIC_CONFIG_KEY and the old one as
// WORKOHOLIC_CONFIG_KEY_PREVIOUS. The first read that only the previous key can
// decrypt re-encrypts the row with the current key; after that the previous
// binding can be removed.

export interface SecretsStoreSecretBinding {
  get(): Promise<string>;
}

export type SecretValue = string | SecretsStoreSecretBinding;

export interface ConfigKeyEnv {
  WORKOHOLIC_CONFIG_KEY?: SecretValue;
  WORKOHOLIC_CONFIG_KEY_PREVIOUS?: SecretValue;
}

export interface ConfigKeys {
  current: string;
  previous: string | null;
}

export async function resolveConfigKeys(env: ConfigKeyEnv): Promise<ConfigKeys> {
  const current = await resolveSecret(env.WORKOHOLIC_CONFIG_KEY, "WORKOHOLIC_CONFIG_KEY");
  if (new TextEncoder().encode(current).byteLength < 32) {
    throw new Error("WORKOHOLIC_CONFIG_KEY must contain at least 32 UTF-8 bytes of key material");
  }
  const previous = await resolveSecret(env.WORKOHOLIC_CONFIG_KEY_PREVIOUS, "WORKOHOLIC_CONFIG_KEY_PREVIOUS");
  // The previous key is only used to decrypt rows written before rotation, so a
  // shorter legacy key is accepted here; every write uses the validated current key.
  return { current, previous: previous && previous !== current ? previous : null };
}

async function resolveSecret(value: SecretValue | undefined, name: string): Promise<string> {
  try {
    return typeof value === "string" ? value.trim() : value ? (await value.get()).trim() : "";
  } catch {
    throw new Error(`${name} could not be resolved`);
  }
}
