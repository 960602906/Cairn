export type CommandLineLike = {
  appendSwitch: (switchName: string) => void
}

export function configureElectronRuntime(
  env: NodeJS.ProcessEnv = process.env,
  commandLine: CommandLineLike = { appendSwitch: () => undefined },
): void {
  if (env.CAIRN_ENABLE_GPU === '1') return

  for (const switchName of ['disable-gpu', 'disable-software-rasterizer']) {
    commandLine.appendSwitch(switchName)
  }
}
