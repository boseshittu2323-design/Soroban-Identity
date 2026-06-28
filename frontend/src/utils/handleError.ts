import {
  SorobanIdentityError,
  type SorobanErrorCode,
} from '../../../sdk/src/errors';

const CODE_MESSAGES: Record<SorobanErrorCode, string> = {
  NOT_FOUND: 'The requested record was not found.',
  UNAUTHORIZED: 'You are not authorized to perform this action.',
  NETWORK_ERROR: 'Unable to reach the Soroban network. Please try again later.',
  VALIDATION_ERROR: 'Invalid input. Please check your data and try again.',
  CONTRACT_ERROR: 'The contract rejected this operation. Please try again.',
  UNKNOWN: 'An unexpected error occurred. Please try again.',
};

export function isNetworkError(error: unknown): boolean {
  if (error instanceof SorobanIdentityError) {
    return error.code === 'NETWORK_ERROR';
  }
  if (error instanceof TypeError) {
    return error.message.includes('fetch') || error.message.includes('network');
  }
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes('ECONNREFUSED') ||
    msg.includes('unreachable') ||
    msg.includes('timeout')
  );
}

function messageForSorobanError(error: SorobanIdentityError): string {
  if (error.code === 'NOT_FOUND' || error.code === 'VALIDATION_ERROR') {
    return error.message;
  }
  return CODE_MESSAGES[error.code];
}

/**
 * Normalizes SDK and runtime errors into a user-facing display string.
 * Unexpected non-Error values are logged to the console.
 */
export function handleError(error: unknown): string {
  if (error instanceof SorobanIdentityError) {
    return messageForSorobanError(error);
  }

  if (isNetworkError(error)) {
    return CODE_MESSAGES.NETWORK_ERROR;
  }

  if (error instanceof Error) {
    return error.message;
  }

  console.error('Unexpected error:', error);
  return CODE_MESSAGES.UNKNOWN;
}
