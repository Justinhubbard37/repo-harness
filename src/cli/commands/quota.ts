import { Command } from 'commander';
import { formatQuotaReport } from '../../core/board/quota';
import { readQuotaReport } from '../../effects/board/quota';
import { formatSeatModes, formatSeatRoutes, seatAccountQuotas } from '../../core/board/seat-routing';
import { readSeatsConfiguration } from '../../effects/board/seats-configuration';

/** Exit 0 when the read completes: a failed source is an `unknown` account with its reason, so the coordinator sees each account. */
export function buildQuotaCommand(): Command {
  return new Command('quota')
    .description('Read the rate-limit windows of each provider account and classify them for dispatch')
    .option('--json', 'Print the readings and states as one JSON line')
    .action(async (options: { json?: boolean }) => {
      // The section is read once: its exhaustion line classifies the windows, and its thresholds route them (#2909).
      const { seats } = readSeatsConfiguration(process.env);
      const report = await readQuotaReport(process.env, seats.routing.exhausted_at_or_above_used);
      if (options.json) {
        console.log(JSON.stringify(report));
        return;
      }
      const quota = seatAccountQuotas(report.accounts, seats.routing);
      console.log(`${formatQuotaReport(report)}\n${formatSeatModes(seats, quota)}\n${formatSeatRoutes(seats, quota)}`);
    });
}
