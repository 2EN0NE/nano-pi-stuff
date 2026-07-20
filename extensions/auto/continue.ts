import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('continue');

/** Send a literal continuation prompt, but never steer or queue one mid-run. */
export default function (pi: ExtensionAPI) {
	log.info('Extension loaded — shift+alt+enter continue shortcut registered');
	pi.registerShortcut('shift+alt+enter', {
		description: 'Send "continue" when the agent is stopped',
		handler: (ctx) => {
			// isIdle() also remains false while Pi is retrying, compacting, or has
			// queued messages, so this cannot accidentally create a follow-up.
			if (!ctx.isIdle()) return;
			log.info('Sending continue via shortcut');
			pi.sendUserMessage('continue');
		},
	});
}
