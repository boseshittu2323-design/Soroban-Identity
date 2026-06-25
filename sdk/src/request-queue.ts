/**
 * Request queue with rate limiting and concurrency control for Soroban RPC calls.
 * Prevents exhausting RPC quotas and handles 429 responses with retry-after.
 */

import { RateLimitError } from './errors';

interface QueuedRequest<T> {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: any) => void;
  retries: number;
  maxRetries: number;
}

/**
 * Concurrency-limited request queue with 429 / transient-error retry support.
 *
 * Wraps all outbound Soroban RPC calls so the SDK never fires more than
 * `maxConcurrent` requests simultaneously. On `429 Too Many Requests` or
 * connection errors the offending request is re-queued with exponential backoff
 * up to `maxRetries` attempts.
 */
export class RequestQueue {
  private queue: QueuedRequest<any>[] = [];
  private activeRequests = 0;
  private readonly maxConcurrent: number;
  private readonly retryDelay: number;
  private processing = false;

  /**
   * @param maxConcurrent Maximum simultaneous in-flight requests. Defaults to `5`.
   * @param retryDelay    Base retry delay in ms for 429 / transient errors.
   *                      Defaults to `1000`.
   */
  constructor(maxConcurrent = 5, retryDelay = 1000) {
    this.maxConcurrent = maxConcurrent;
    this.retryDelay = retryDelay;
  }

  /**
   * Enqueue an async function for rate-limited execution.
   *
   * The returned promise resolves (or rejects) once `fn` completes
   * successfully or exhausts its retry budget.
   *
   * @param fn         Async function to execute.
   * @param maxRetries Maximum retry attempts on 429 / transient errors.
   *                   Defaults to `3`.
   * @returns Promise that resolves with the return value of `fn`.
   * @throws The last error thrown by `fn` after retries are exhausted.
   */
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
      } else if (this.is429(error)) {
        request.reject(new RateLimitError(this.getRetryDelay(error)));
      } else {
        request.reject(error);
      }
    }
  }

  private is429(error: any): boolean {
    const errorStr = error?.toString() || '';
    return errorStr.includes('429') || errorStr.includes('Too Many Requests');
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