import ErrorBoundary from './ErrorBoundary';
import type { LogEvent } from './LogEvent';
import makeLogEvent from './LogEvent';
import Identity from './StatsigIdentity';
import StatsigNetwork, { StatsigEndpoint } from './StatsigNetwork';
import StatsigSDKOptions from './StatsigSDKOptions';
import { EvaluationDetails } from './StatsigStore';
import { StatsigUser } from './StatsigUser';
import { STATSIG_LOCAL_STORAGE_LOGGING_REQUEST_KEY } from './utils/Constants';
import Diagnostics from './utils/Diagnostics';
import StatsigLocalStorage from './utils/StatsigLocalStorage';

const INTERNAL_EVENT_PREFIX = 'statsig::';
const CONFIG_EXPOSURE_EVENT = INTERNAL_EVENT_PREFIX + 'config_exposure';
const LAYER_EXPOSURE_EVENT = INTERNAL_EVENT_PREFIX + 'layer_exposure';
const GATE_EXPOSURE_EVENT = INTERNAL_EVENT_PREFIX + 'gate_exposure';
const LOG_FAILURE_EVENT = INTERNAL_EVENT_PREFIX + 'log_event_failed';
const DIAGNOSTICS_EVENT = INTERNAL_EVENT_PREFIX + 'diagnostics';
const DEFAULT_VALUE_WARNING =
  INTERNAL_EVENT_PREFIX + 'default_value_type_mismatch';

type FailedLogEventBody = {
  events: object[];
  statsigMetadata: object;
  time: number;
};

const MS_RETRY_LOGS_CUTOFF = 5 * 24 * 60 * 60 * 1000;
const MAX_BATCHES_TO_RETRY = 100;
const MAX_FAILED_EVENTS = 1000;
const MAX_LOCAL_STORAGE_SIZE = 1024 * MAX_FAILED_EVENTS;

export default class StatsigLogger {
  private readonly _options: StatsigSDKOptions;
  private readonly _identity: Identity;
  private readonly _network: StatsigNetwork;
  private readonly _errorBoundary: ErrorBoundary;

  private queue: object[];

  private flushInterval: ReturnType<typeof setInterval> | null;
  private loggedErrors: Set<string>;
  private failedLogEvents: FailedLogEventBody[];
  private exposureDedupeKeys: Record<string, number>;
  private failedLogEventCount = 0;

  public constructor(
    options: StatsigSDKOptions,
    identity: Identity,
    network: StatsigNetwork,
    errorBoundary: ErrorBoundary,
  ) {
    this._options = options;
    this._identity = identity;
    this._network = network;
    this._errorBoundary = errorBoundary;

    this.queue = [];
    this.flushInterval = null;
    this.loggedErrors = new Set();

    this.failedLogEvents = [];
    this.exposureDedupeKeys = {};
    this.failedLogEventCount = 0;
    this._init();
  }

  public log(event: LogEvent): void {
    try {
      if (
        !this._options.disableCurrentPageLogging &&
        typeof window !== 'undefined' &&
        window != null &&
        typeof window.location === 'object' &&
        typeof window.location.href === 'string'
      ) {
        // https://stackoverflow.com/questions/6257463/how-to-get-the-url-without-any-parameters-in-javascript
        const parts = window.location.href.split(/[?#]/);
        if (parts?.length > 0) {
          event.statsigMetadata.currentPage = parts[0];
        }
      }
    } catch (_e) {}

    this.queue.push(event);

    if (this.queue.length >= this._options.loggingBufferMaxSize) {
      this.flush();
    }
  }

  public resetDedupeKeys() {
    this.exposureDedupeKeys = {};
  }

  public logGateExposure(
    user: StatsigUser | null,
    gateName: string,
    gateValue: boolean,
    ruleID: string,
    secondaryExposures: Record<string, string>[],
    details: EvaluationDetails,
    isManualExposure: boolean,
  ) {
    const dedupeKey = gateName + String(gateValue) + ruleID + details.reason;
    if (!this._shouldLogExposure(dedupeKey)) {
      return;
    }

    const metadata: Record<string, unknown> = {
      gate: gateName,
      gateValue: String(gateValue),
      ruleID: ruleID,
      reason: details.reason,
      time: details.time,
    };

    if (isManualExposure) {
      metadata['isManualExposure'] = 'true';
    }

    const gateExposure = makeLogEvent(
      GATE_EXPOSURE_EVENT,
      user,
      this._identity._statsigMetadata,
      null,
      metadata,
      secondaryExposures,
    );
    this.log(gateExposure);
  }

  public logConfigExposure(
    user: StatsigUser | null,
    configName: string,
    ruleID: string,
    secondaryExposures: Record<string, string>[],
    details: EvaluationDetails,
    isManualExposure: boolean,
  ) {
    const dedupeKey = configName + ruleID + details.reason;
    if (!this._shouldLogExposure(dedupeKey)) {
      return;
    }

    const metadata: Record<string, unknown> = {
      config: configName,
      ruleID: ruleID,
      reason: details.reason,
      time: details.time,
    };

    if (isManualExposure) {
      metadata['isManualExposure'] = 'true';
    }

    const configExposure = makeLogEvent(
      CONFIG_EXPOSURE_EVENT,
      user,
      this._identity._statsigMetadata,
      null,
      metadata,
      secondaryExposures,
    );
    this.log(configExposure);
  }

  public logLayerExposure(
    user: StatsigUser | null,
    configName: string,
    ruleID: string,
    secondaryExposures: Record<string, string>[],
    allocatedExperiment: string,
    parameterName: string,
    isExplicitParameter: boolean,
    details: EvaluationDetails,
    isManualExposure: boolean,
  ) {
    const dedupeKey = [
      configName,
      ruleID,
      allocatedExperiment,
      parameterName,
      String(isExplicitParameter),
      details.reason,
    ].join('|');

    if (!this._shouldLogExposure(dedupeKey)) {
      return;
    }

    const metadata: Record<string, unknown> = {
      config: configName,
      ruleID: ruleID,
      allocatedExperiment,
      parameterName,
      isExplicitParameter: String(isExplicitParameter),
      reason: details.reason,
      time: details.time,
    };

    if (isManualExposure) {
      metadata['isManualExposure'] = 'true';
    }

    const configExposure = makeLogEvent(
      LAYER_EXPOSURE_EVENT,
      user,
      this._identity._statsigMetadata,
      null,
      metadata,
      secondaryExposures,
    );
    this.log(configExposure);
  }

  public logConfigDefaultValueFallback(
    user: StatsigUser | null,
    message: string,
    metadata: object,
  ): void {
    const defaultValueEvent = makeLogEvent(
      DEFAULT_VALUE_WARNING,
      user,
      this._identity._statsigMetadata,
      message,
      metadata,
    );
    this.log(defaultValueEvent);
    this.loggedErrors.add(message);
  }

  public shutdown(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }

    this.flush(true);
  }

  public flush(isClosing: boolean = false): void {
    if (this.queue.length === 0) {
      return;
    }

    const statsigMetadata = this._identity._statsigMetadata;
    const oldQueue = this.queue;
    this.queue = [];
    if (
      isClosing &&
      !this._network.supportsKeepalive() &&
      typeof navigator !== 'undefined' &&
      navigator != null &&
      // @ts-ignore
      navigator.sendBeacon
    ) {
      const beacon = this._network.sendLogBeacon({
        events: oldQueue,
        statsigMetadata,
      });
      if (!beacon) {
        this.queue = oldQueue.concat(this.queue);
        if (this.queue.length > 0) {
          this._addFailedRequest({
            events: this.queue,
            statsigMetadata,
            time: Date.now(),
          });
          this.queue = [];
        }
        this._saveFailedRequests();
      }
      return;
    }

    const processor = this;
    this._network
      .postToEndpoint(
        StatsigEndpoint.Rgstr,
        {
          events: oldQueue,
          statsigMetadata,
        },
        3 /* retries */,
        1000 /* backoff */,
        isClosing /* useKeepalive */,
      )
      .then((response) => {
        if (!response.ok) {
          throw response;
        }
      })
      .catch((error) => {
        if (typeof error.text === 'function') {
          error.text().then((errorText: string) => {
            this._errorBoundary._logError(
              LOG_FAILURE_EVENT,
              error,
              async () => {
                return {
                  eventCount: oldQueue.length,
                  error: errorText,
                };
              },
            );
          });
        } else {
          this._errorBoundary._logError(LOG_FAILURE_EVENT, error, async () => {
            return {
              eventCount: oldQueue.length,
              error: error.message,
            };
          });
        }
        processor._newFailedRequest(LOG_FAILURE_EVENT, oldQueue);
      })
      .finally(async () => {
        if (isClosing) {
          if (this.queue.length > 0) {
            this._addFailedRequest({
              events: this.queue,
              statsigMetadata,
              time: Date.now(),
            });

            // on app background/window blur, save unsent events as a request and clean up the queue (in case app foregrounds)
            this.queue = [];
          }
          await processor._saveFailedRequests();
        }
      });
  }

  public async sendSavedRequests(): Promise<void> {
    let failedRequests;
    let fireAndForget = false;
    failedRequests = StatsigLocalStorage.getItem(
      STATSIG_LOCAL_STORAGE_LOGGING_REQUEST_KEY,
    );
    if (failedRequests == null) {
      this._clearLocalStorageRequests();
      return;
    }
    if (failedRequests.length > MAX_LOCAL_STORAGE_SIZE) {
      fireAndForget = true;
    }
    let requestBodies = [];
    try {
      requestBodies = JSON.parse(failedRequests);
      for (const requestBody of requestBodies) {
        if (
          requestBody != null &&
          requestBody.events &&
          Array.isArray(requestBody.events)
        ) {
          this._network
            .postToEndpoint(StatsigEndpoint.Rgstr, requestBody)
            .then((response) => {
              if (!response.ok) {
                throw Error(response.status + '');
              }
            })
            .catch((_e) => {
              if (fireAndForget) {
                return;
              }
              this._addFailedRequest(requestBody);
            });
        }
      }
    } catch (_e) {
    } finally {
      this._clearLocalStorageRequests();
    }
  }

  private _init(): void {
    if (
      typeof window !== 'undefined' &&
      typeof window.addEventListener === 'function'
    ) {
      window.addEventListener('blur', () => this.flush(true));
      window.addEventListener('beforeunload', () => this.flush(true));
      window.addEventListener('load', () => {
        setTimeout(() => this.flush(), 100);
        setTimeout(() => this.flush(), 1000);
      });
    }
    if (
      typeof document !== 'undefined' &&
      typeof document.addEventListener === 'function'
    ) {
      document.addEventListener('visibilitychange', () => {
        this.flush(document.visibilityState !== 'visible');
      });
    }
    if (
      !this._options.ignoreWindowUndefined &&
      (typeof window === 'undefined' || window == null)
    ) {
      // dont set the flush interval outside of client browser environments
      return;
    }
    if (this._options.localMode) {
      // unnecessary interval in local mode since logs dont flush anyway
      return;
    }
    const me = this;
    this.flushInterval = setInterval(() => {
      me.flush();
    }, this._options.loggingIntervalMillis);

    // Quick flush
    setTimeout(() => this.flush(), 100);
    setTimeout(() => this.flush(), 1000);
  }

  private _shouldLogExposure(key: string): boolean {
    const lastTime = this.exposureDedupeKeys[key];
    const now = Date.now();
    if (lastTime == null) {
      this.exposureDedupeKeys[key] = now;
      return true;
    }
    if (lastTime >= now - 600 * 1000) {
      return false;
    }
    this.exposureDedupeKeys[key] = now;
    return true;
  }

  private async _saveFailedRequests(): Promise<void> {
    if (this.failedLogEvents.length > 0) {
      const requestsCopy = JSON.stringify(this.failedLogEvents);
      if (requestsCopy.length > MAX_LOCAL_STORAGE_SIZE) {
        this._clearLocalStorageRequests();
        return;
      }
      StatsigLocalStorage.setItem(
        STATSIG_LOCAL_STORAGE_LOGGING_REQUEST_KEY,
        requestsCopy,
      );
    }
  }

  private _addFailedRequest(requestBody: FailedLogEventBody): void {
    if (requestBody.time < Date.now() - MS_RETRY_LOGS_CUTOFF) {
      return;
    }
    if (this.failedLogEvents.length > MAX_BATCHES_TO_RETRY) {
      return;
    }
    const additionalEvents = requestBody.events.length;
    if (this.failedLogEventCount + additionalEvents > MAX_FAILED_EVENTS) {
      return;
    }
    this.failedLogEvents.push(requestBody);
    this.failedLogEventCount += additionalEvents;
  }

  private _clearLocalStorageRequests(): void {
    StatsigLocalStorage.removeItem(STATSIG_LOCAL_STORAGE_LOGGING_REQUEST_KEY);
  }

  private _newFailedRequest(name: string, queue: object[]): void {
    if (this.loggedErrors.has(name)) {
      return;
    }
    this.loggedErrors.add(name);

    this.failedLogEvents.push({
      events: queue,
      statsigMetadata: this._identity._statsigMetadata,
      time: Date.now(),
    });

    this._saveFailedRequests().then(() => {});
  }
}
