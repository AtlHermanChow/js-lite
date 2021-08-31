import type { StatsigUser } from './StatsigUser';

export default class LogEvent {
  private eventName: string;
  private user: StatsigUser | null = null;
  private value: string | number | null = null;
  private metadata: object | null = null;
  private time: number;
  private statsigMetadata: Record<string, string | number>;

  public constructor(eventName: string) {
    this.eventName = eventName;
    this.statsigMetadata = {};
    this.time = Date.now();
  }

  public getName() {
    return this.eventName;
  }

  public setValue(value: string | number | null) {
    this.value = value;
  }

  public setMetadata(metadata: object | null) {
    this.metadata = metadata;
  }

  public addStatsigMetadata(key: string, value: string | number) {
    this.statsigMetadata[key] = value;
  }

  public setUser(newUser: StatsigUser | null) {
    // Need to remove private attributes from logs and also keep in the original user for evaluations.
    this.user = { ...newUser };
    delete this.user.privateAttributes;
  }

  public toJsonObject(): Record<string, any> {
    return {
      eventName: this.eventName,
      user: this.user,
      value: this.value,
      metadata: this.metadata,
      time: this.time,
      statsigMetadata: this.statsigMetadata,
    };
  }
}
