import { formatReport, runDoctor } from "../doctor.js";
import type { DoctorOptions, DoctorReport } from "../doctor.js";

/** Options for {@link doctorCommand}. */
export interface DoctorCommandOptions extends DoctorOptions {
  /** Where to write the checklist. Defaults to `console.log`. */
  write?: (line: string) => void;
}

/**
 * Runs the diagnostics and prints the checklist.
 *
 * @returns The report, so the CLI can set a non-zero exit code without re-running the checks.
 */
export async function doctorCommand(options: DoctorCommandOptions = {}): Promise<DoctorReport> {
  const write = options.write ?? ((line: string) => console.log(line));
  const report = await runDoctor(options);
  write(formatReport(report));
  return report;
}
