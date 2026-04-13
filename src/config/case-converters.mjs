/**
 * Case Conversion Utilities
 *
 * Converts strings between different case styles for file naming.
 * Handles various input formats (snake_case, camelCase, PascalCase, kebab-case).
 *
 * Usage:
 *   import { toKebabCase, toCamelCase, toPascalCase, toSnakeCase } from './case-converters.mjs';
 *
 *   toKebabCase('deal_state');  // 'deal-state'
 *   toPascalCase('deal_state'); // 'DealState'
 */

// ============================================================================
// Input Normalization
// ============================================================================

/**
 * Split a string into words, handling various input formats
 *
 * Handles:
 * - snake_case: deal_state → ['deal', 'state']
 * - kebab-case: deal-state → ['deal', 'state']
 * - camelCase: dealState → ['deal', 'State']
 * - PascalCase: DealState → ['Deal', 'State']
 *
 * @param {string} str - Input string in any case format
 * @returns {string[]} Array of lowercased words
 */
function splitWords(str) {
  if (!str) return [];

  return (
    str
      // Insert space before capitals in camelCase/PascalCase
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      // Replace underscores and hyphens with spaces
      .replace(/[_-]/g, ' ')
      // Split on spaces
      .split(/\s+/)
      // Filter empty strings and lowercase all words
      .filter((word) => word.length > 0)
      .map((word) => word.toLowerCase())
  );
}

// ============================================================================
// Case Converters
// ============================================================================

/**
 * Convert to kebab-case
 *
 * @param {string} str - Input string in any case format
 * @returns {string} kebab-case string
 *
 * @example
 * toKebabCase('deal_state')  // 'deal-state'
 * toKebabCase('DealState')   // 'deal-state'
 * toKebabCase('dealState')   // 'deal-state'
 */
export function toKebabCase(str) {
  return splitWords(str).join('-');
}

/**
 * Convert to snake_case
 *
 * @param {string} str - Input string in any case format
 * @returns {string} snake_case string
 *
 * @example
 * toSnakeCase('deal-state')  // 'deal_state'
 * toSnakeCase('DealState')   // 'deal_state'
 * toSnakeCase('dealState')   // 'deal_state'
 */
export function toSnakeCase(str) {
  return splitWords(str).join('_');
}

/**
 * Convert to camelCase
 *
 * @param {string} str - Input string in any case format
 * @returns {string} camelCase string
 *
 * @example
 * toCamelCase('deal_state')  // 'dealState'
 * toCamelCase('deal-state')  // 'dealState'
 * toCamelCase('DealState')   // 'dealState'
 */
export function toCamelCase(str) {
  const words = splitWords(str);
  if (words.length === 0) return '';

  return words
    .map((word, index) =>
      index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)
    )
    .join('');
}

/**
 * Convert to PascalCase
 *
 * @param {string} str - Input string in any case format
 * @returns {string} PascalCase string
 *
 * @example
 * toPascalCase('deal_state')  // 'DealState'
 * toPascalCase('deal-state')  // 'DealState'
 * toPascalCase('dealState')   // 'DealState'
 */
export function toPascalCase(str) {
  const words = splitWords(str);
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('');
}

// ============================================================================
// Case Application
// ============================================================================

/**
 * Apply a case style to a string
 *
 * @param {string} str - Input string in any case format
 * @param {'kebab-case' | 'snake_case' | 'camelCase' | 'PascalCase'} caseStyle - Target case style
 * @returns {string} String in target case style
 */
export function applyCase(str, caseStyle) {
  switch (caseStyle) {
    case 'kebab-case':
      return toKebabCase(str);
    case 'snake_case':
      return toSnakeCase(str);
    case 'camelCase':
      return toCamelCase(str);
    case 'PascalCase':
      return toPascalCase(str);
    default:
      // Default to kebab-case for safety
      return toKebabCase(str);
  }
}

/**
 * Get the separator for a case style
 *
 * @param {'kebab-case' | 'snake_case' | 'camelCase' | 'PascalCase'} caseStyle
 * @returns {string} Separator character (or empty string for camel/Pascal)
 */
export function getCaseSeparator(caseStyle) {
  switch (caseStyle) {
    case 'kebab-case':
      return '-';
    case 'snake_case':
      return '_';
    case 'camelCase':
    case 'PascalCase':
      return ''; // No separator, uses capitalization
    default:
      return '-';
  }
}

// ============================================================================
// Exports
// ============================================================================

// Named export for splitWords (used internally, exported for testing)
export { splitWords };

export default {
  toKebabCase,
  toSnakeCase,
  toCamelCase,
  toPascalCase,
  applyCase,
  getCaseSeparator,
  splitWords,
};
