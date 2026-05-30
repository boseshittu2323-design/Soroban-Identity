/**
 * Request queue with rate limiting and concurrency control for Soroban RPC calls.
 * Prevents exhausting RPC quotas and handles 429 responses with retry-after.
 */

interface QueuedRequest<T> {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: any) => void;
  retries: number;
  maxRetries: number;
}

export class RequestQueue {
  private queue: QueuedRequest<any>[] = [];
  private activeRequests = 0;
  private readonly maxConcurrent: number;
  private readonly retryDelay: number;
  private processing = false;

  constructor(maxConcurrent = 5, retryDelay = 1000) {
    this.maxConcurrent = maxConcurrent;
    this.retryDelay = retryDelay;
  }

  async enqueue<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        fn,
        resolve,
        reject,
        retries: 0,
        maxRetries,
      });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.activeRequests >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    this.processing = true;
    
    while (this.queue.length > 0 && this.activeRequests < this.maxConcurrent) {
      const request = this.queue.shift()!;
      this.activeRequests++;
      
      this.executeRequest(request).finally(() => {
        this.activeRequests--;
        this.processQueue();
      });
    }
    
    this.processing = false;
  }

  private async executeRequest<T>(request: QueuedRequest<T>): Promise<void> {
    try {
      const result = await request.fn();
      request.resolve(result);
    } catch (error: any) {
      if (this.shouldRetry(error, request)) {
        request.retries++;
        const delay = this.getRetryDelay(error);
        setTimeout(() => {
          this.queue.unshift(request);
          this.processQueue();
        }, delay);
      } else {
        request.reject(error);
      }
    }
  }

  private shouldRetry(error: any, request: QueuedRequest<any>): boolean {
    if (request.retries >= request.maxRetries) {
      return false;
    }

    // Retry on 429 (rate limit) or transient network errors
    const errorStr = error?.toString() || '';
    return (
      errorStr.includes('429') ||
      errorStr.includes('Too Many Requests') ||
      errorStr.includes('ECONNRESET') ||
      errorStr.includes('ETIMEDOUT') ||
      errorStr.includes('503')
    );
  }

  private getRetryDelay(error: any): number {
    // Check for Retry-After header in 429 responses
    const errorStr = error?.toString() || '';
    const retryAfterMatch = errorStr.match(/retry-after:\s*(\d+)/i);
    
    if (retryAfterMatch) {
      return parseInt(retryAfterMatch[1]) * 1000; // Convert to ms
    }

    // Exponential backoff for other errors
    return this.retryDelay * Math.pow(2, Math.min(3, error.retries || 0));
  }
}