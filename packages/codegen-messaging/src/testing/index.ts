/**
 * @pattern-stack/codegen-messaging/testing — test-time helpers.
 *
 * Conformance checks for messaging adapter implementations, kept out of the main
 * runtime barrel so production bundles don't pull in test scaffolding.
 */

export * from './assert-messaging-adapter';
