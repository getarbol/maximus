/**
 * The telemetry switch and an invocation's diagnostics: a switch function decides per env and stays off
 * without one, `reportUnexpected` logs a safe description and tells the invocation's observers, and neither
 * a failing observer nor a failing console reaches the caller.
 */
import { afterEach, expect, it, vi } from 'vite-plus/test';

import {
  diagnosticsEnabled,
  reportUnexpected,
  telemetryEnabled,
  withDiagnostics,
  withTelemetry,
} from '../../src/telemetry.ts';
import type { TelemetryConfig } from '../../src/telemetry.ts';

/** The binding the telemetry switch reads. */
interface Env {
  TELEMETRY: 'on' | 'off';
}

const on: Env = { TELEMETRY: 'on' };
const off: Env = { TELEMETRY: 'off' };
const requestId = '00000000-0000-4000-8000-000000000001';

afterEach(() => {
  vi.restoreAllMocks();
});

it('decides per env with a switch function, and stays off when there is no env to read', () => {
  const enabled = vi.fn((env: Env) => env.TELEMETRY === 'on');
  expect(telemetryEnabled({ enabled }, on)).toBe(true);
  expect(telemetryEnabled({ enabled }, off)).toBe(false);
  expect(telemetryEnabled({ enabled }, undefined)).toBe(false);
  expect(enabled).toHaveBeenCalledTimes(2);
  expect(telemetryEnabled({ enabled: false }, on)).toBe(false);
  expect(telemetryEnabled({ enabled: true }, undefined)).toBe(true);
  expect(telemetryEnabled({}, undefined)).toBe(true);
  expect(telemetryEnabled(undefined, undefined)).toBe(true);
});

it("runs work inside the diagnostics its env turns on, telling the configuration's observers of unexpected errors", () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const error = vi.fn();
  const config: TelemetryConfig<Env> = { enabled: (env) => env.TELEMETRY === 'on', observers: [{ error }] };
  const failure = new TypeError('PRIVATE clinical note');
  const run = (env: Env) =>
    withTelemetry(config, env, () => {
      reportUnexpected(failure, 'queue', requestId);
      return diagnosticsEnabled();
    });
  expect(run(off)).toBe(false);
  expect(log).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  expect(run(on)).toBe(true);
  expect(error).toHaveBeenCalledExactlyOnceWith(failure, 'queue', requestId);
  expect(log).toHaveBeenCalledOnce();
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
    event: 'maximus.unexpected',
    surface: 'queue',
    requestId,
    name: 'TypeError',
  });
  expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE');
});

it('isolates observers from one another when their error callbacks fail', () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const second = vi.fn();
  const observers = [
    {
      error: () => {
        throw new Error('exporter failure');
      },
    },
    {},
    { error: second },
  ];
  expect(() =>
    withDiagnostics(
      true,
      () => reportUnexpected(new RangeError('unexpected'), 'operation', requestId),
      observers
    )
  ).not.toThrow();
  expect(second).toHaveBeenCalledExactlyOnceWith(expect.any(RangeError), 'operation', requestId);
});

it('still tells observers of an unexpected error when the native console fails', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {
    throw new Error('console unavailable');
  });
  const error = vi.fn();
  expect(() =>
    withDiagnostics(true, () => reportUnexpected(new RangeError('unexpected')), [{ error }])
  ).not.toThrow();
  expect(error).toHaveBeenCalledExactlyOnceWith(expect.any(RangeError), 'application', undefined);
});

it('reports outside any invocation to the native log alone, naming an unknown error class generically', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(diagnosticsEnabled()).toBe(true);
  reportUnexpected(Object.assign(new Error('PRIVATE provider answer'), { name: 'ProviderError' }));
  expect(log).toHaveBeenCalledOnce();
  const logged: unknown = JSON.parse(String(log.mock.calls[0]?.[0]));
  expect(logged).toMatchObject({ event: 'maximus.unexpected', surface: 'application', name: 'UnknownError' });
  expect(logged).not.toHaveProperty('requestId');
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/PRIVATE|ProviderError/u);
});
