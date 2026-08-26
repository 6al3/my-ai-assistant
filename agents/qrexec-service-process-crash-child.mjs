import process from 'node:process';
import { handleQrexecEnvelope } from './qrexec-coordinator-adapter.mjs';
import { runQrexecServiceProcess } from './qrexec-service-process.mjs';

const POINTS = new Set(['before-mutation', 'after-mutation', 'after-journal-commit']);
const point = process.env.DIG_TEST_QREXEC_CRASH_POINT;

if (!POINTS.has(point)) {
  process.stderr.write('DIG_QREXEC_TEST_CRASH_POINT_INVALID\n');
  process.exitCode = 64;
} else {
  const handler = async (envelope, options) => {
    if (point === 'before-mutation') process.exit(85);
    if (point === 'after-mutation') {
      return handleQrexecEnvelope(envelope, {
        ...options,
        afterMutation: async () => process.exit(86)
      });
    }
    const response = await handleQrexecEnvelope(envelope, options);
    process.exit(87);
    return response;
  };

  const code = await runQrexecServiceProcess({ handler });
  process.exitCode = code;
}
