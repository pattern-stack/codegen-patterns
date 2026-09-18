/**
 * Type-level checks for the library `Communication` capability (CAP-3),
 * compiled by the smoke's `tsc` leg — never executed.
 *
 * `findByRole`'s `role` is typed by the generated `communicationConfig.roles`
 * keys, on the repository AND through the generated service forwarder. Each
 * `@ts-expect-error` below must be consumed: if the role parameter ever widens
 * back to `string`, the directive is unused and `tsc` fails (TS2578).
 */
import type { MeetingRepository } from '@modules/meetings/meeting.repository';
import type { MeetingService } from '@modules/meetings/meeting.service';
import type { Meeting } from '@modules/meetings/meeting.entity';

export async function rolesAreTyped(repo: MeetingRepository, service: MeetingService): Promise<Meeting[]> {
	const attended: Meeting[] = await repo.findByRole('attendees', 'contact-id');
	const hosted: Meeting[] = await service.findByRole('host', 'contact-id');
	const about: Meeting[] = await service.findByRole('about', 'account-id');
	// @ts-expect-error — not a declared role of meeting
	await repo.findByRole('organizer', 'contact-id');
	// @ts-expect-error — not a declared role, through the service forwarder
	await service.findByRole('atendees', 'contact-id');
	const participants = await service.participants('meeting-id');
	const roles: string[] = participants.map((p) => p.role);
	void roles;
	return [...attended, ...hosted, ...about];
}
