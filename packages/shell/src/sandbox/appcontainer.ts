/**
 * AppContainer 的实验性支持（M5-04，ADR-0034）：配置创建/复用、删除、工作区 ACL 授予与网络能力。
 *
 * AppContainer 不是默认档位：M5-00 预研中用户目录里的 Node、pnpm、Git 等工具链无法启动。这里保留
 * 实现用于诊断与后续重新评估；默认档位使用受限令牌。
 */
import { createIcaclsRunner, type IcaclsOptions } from './icacls.js'
import { SandboxError, SandboxErrorCode, type SandboxNetwork } from './types.js'

export type ContainerAccess = 'read' | 'modify'

const ACCESS_FLAG: Readonly<Record<ContainerAccess, string>> = {
  read: '(OI)(CI)(RX)',
  modify: '(OI)(CI)(M)',
}

export interface ContainerAcl {
  grant(directory: string, sid: string, access: ContainerAccess): Promise<void>
  revoke(directory: string, sid: string): Promise<void>
}

export function createContainerAcl(options: IcaclsOptions = {}): ContainerAcl {
  const run = createIcaclsRunner(options)
  const execute = async (args: readonly string[], what: string) => {
    let code: number
    try {
      code = await run(args)
    } catch (error) {
      throw new SandboxError(
        SandboxErrorCode.SetupFailed,
        `Cannot ${what} (${(error as Error).message}).`,
        {},
        { cause: error },
      )
    }
    if (code !== 0) {
      throw new SandboxError(
        SandboxErrorCode.SetupFailed,
        `Cannot ${what} (icacls exited with ${code}).`,
        { exitCode: String(code) },
      )
    }
  }
  return {
    grant: (directory, sid, access) =>
      execute([directory, '/grant', `*${sid}:${ACCESS_FLAG[access]}`], 'grant sandbox access'),
    revoke: (directory, sid) =>
      execute([directory, '/remove:g', `*${sid}`], 'revoke sandbox access'),
  }
}

/** 网络策略对应的 AppContainer 能力 SID；没有网络时不授予任何能力。 */
export function networkCapabilities(network: SandboxNetwork): readonly string[] {
  switch (network) {
    case 'none':
      return []
    case 'internet':
      return ['S-1-15-3-1']
    case 'private':
      // 私网在 AppContainer 下还需要回环豁免；M5-00 未实现，因此只授予私网能力。
      return ['S-1-15-3-3']
  }
}

/**
 * AppContainer 配置名：稳定哈希，不含项目路径、用户名或凭据。调用方给出安装标识（用户 SID 与安装 ID 的
 * 摘要），这里只做长度与字符约束。
 */
export function appContainerName(identity: string): string {
  const safe = identity.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (safe.length === 0) {
    throw new SandboxError(SandboxErrorCode.AppContainerFailed, 'Empty sandbox identity.')
  }
  return `com.cairn.sandbox.${safe.slice(0, 50)}`
}
