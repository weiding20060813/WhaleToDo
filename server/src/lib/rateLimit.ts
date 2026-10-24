// 限流：固定窗口计数，内存实现（单进程）。多实例部署时需换 Redis 等共享存储。
// 设计取舍：
//  - 固定窗口实现简单、可预测；窗口边界允许 2 倍突发，对登录/注册足够
//  - 按键（IP 或 IP+用户名）分开计数，避免一个用户影响其他用户
//  - 只记录失败次数：登录成功即清零，正常用户不会被误伤
export interface RateLimitResult {
  allowed: boolean;
  /** 剩余可用次数 */
  remaining: number;
  /** 被拒时建议的重试等待毫秒数 */
  retryAfterMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class FixedWindowLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('limit 必须是正整数');
    if (!Number.isInteger(windowMs) || windowMs < 1) throw new Error('windowMs 必须是正整数');
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** 记一次尝试；返回是否放行。超过上限时不再自增，避免计数器无限增长。 */
  hit(key: string): RateLimitResult {
    const t = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= t) {
      bucket = { count: 0, resetAt: t + this.windowMs };
      this.buckets.set(key, bucket);
    }
    if (bucket.count >= this.limit) {
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, bucket.resetAt - t) };
    }
    bucket.count += 1;
    return {
      allowed: true,
      remaining: this.limit - bucket.count,
      retryAfterMs: 0,
    };
  }

  /** 成功后清零（例如登录成功） */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** 清理过期桶，防止长时间运行内存膨胀 */
  sweep(): number {
    const t = this.now();
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= t) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.buckets.size;
  }
}
