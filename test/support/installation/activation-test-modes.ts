type ModeEnvironment = Readonly<Record<string, string | undefined>>;

export function assertActivationTestModes(
  extra: ModeEnvironment,
  inherited: ModeEnvironment,
): void {
  const fault = extra.REVO_TEST_ACTIVATION_FAULT ?? inherited.REVO_TEST_ACTIVATION_FAULT;
  const diagnostics =
    extra.REVO_TEST_ACTIVATION_DIAGNOSTICS ?? inherited.REVO_TEST_ACTIVATION_DIAGNOSTICS;

  if (diagnostics !== undefined && diagnostics !== '1') {
    throw new Error('invalid activation diagnostic mode');
  }
  if (fault && diagnostics === '1') {
    throw new Error('activation fault and diagnostic modes cannot be combined');
  }
}
