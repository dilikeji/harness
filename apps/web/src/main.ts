/** Browser entry for the Web client. */
import '@deepseek-ai/dsh-client-ui-theme/brand-font.css'
import { AppWebEntry, applyIndexInjections } from '@deepseek-ai/dsh-client-web'
import { ensureTenant } from './tenant-gate.ts'

interface DesktopBootGlobal {
  dshDesktopBoot?: {
    failed(message: string): Promise<void>
    ready(): Promise<{ injections: Parameters<typeof applyIndexInjections>[0]; streamBaseUrl: string }>
  }
}
const desktop = (globalThis as DesktopBootGlobal).dshDesktopBoot
const reportFailure = (reason: unknown): void => {
  if (desktop === undefined) throw reason
  void desktop.failed(reason instanceof Error ? reason.message : String(reason)).catch(console.error)
}

/**
 * Start the client shell.
 * @param el - application mount point, cleared of the gate's notice by the first mount.
 */
function startApplication(el: HTMLElement): void {
  const entry = new AppWebEntry(el)
  if (desktop !== undefined) {
    const gate = (globalThis as { __DSH_BOOT_READY__?: PromiseWithResolvers<void> }).__DSH_BOOT_READY__
    if (gate === undefined) throw new Error('desktop web: boot readiness is missing')
    void desktop.ready().then(async ({ injections, streamBaseUrl }) => {
      const transport = globalThis as { __DSH_TRANSPORT__?: { ownsHost: boolean; streamBaseUrl: string } }
      transport.__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl }
      await applyIndexInjections(injections, src => new Promise<void>((resolve, reject) => {
        const script = document.createElement('script')
        script.src = src
        script.onload = () => { resolve() }
        script.onerror = () => { reject(new Error(`desktop web: failed to load ${src}`)) }
        document.head.append(script)
      }))
      gate.resolve()
    }).catch((error: unknown) => { gate.reject(error) })
  }
  void entry.run(desktop === undefined ? undefined : reportFailure)
}

/**
 * Establish identity, then start the shell.
 *
 * The order is the whole point: under tenant authentication every request the
 * application makes carries this page's token, so a shell started without one
 * renders a surface that answers 401 to everything it asks. The gate renders its
 * own blocking notice on failure, which is why the shell is simply not started.
 */
async function boot(): Promise<void> {
  try {
    const el = document.getElementById('root')
    if (el === null) throw new Error('web app: missing #root')
    if (await ensureTenant(el)) startApplication(el)
  } catch (reason) {
    reportFailure(reason)
  }
}

void boot()
