/**
 * The names a route's method and path give it: its operation name, its title and its group, for
 * collections, items, actions, singletons, nested resources, the caller's own resources and later versions.
 */
import { expect, it } from 'vite-plus/test';

import { routeGroup, routeName, routeTitle, singular } from '../../src/project/names.ts';

/** Each route, and the name, title and group it derives. */
const ROUTES = [
  ['GET', '/v1/notes', 'listNotes', 'List notes', 'Notes'],
  ['GET', '/v1/notes/{noteId}', 'getNote', 'Get a note', 'Notes'],
  ['POST', '/v1/notes', 'createNote', 'Create a note', 'Notes'],
  ['PATCH', '/v1/notes/{noteId}', 'updateNote', 'Update a note', 'Notes'],
  ['PUT', '/v1/notes/{noteId}', 'replaceNote', 'Replace a note', 'Notes'],
  ['DELETE', '/v1/notes/{noteId}', 'deleteNote', 'Delete a note', 'Notes'],
  ['POST', '/v1/notes/{noteId}', 'postNote', 'Post a note', 'Notes'],
  ['POST', '/v1/notes/{noteId}/archive', 'archiveNote', 'Archive a note', 'Notes'],
  ['POST', '/v1/notes/{noteId}/mark-read', 'markNoteRead', 'Mark a note read', 'Notes'],
  [
    'POST',
    '/v1/appointments/{appointmentId}/check-in',
    'checkInAppointment',
    'Check in an appointment',
    'Appointments',
  ],
  ['POST', '/v1/notes/search', 'searchNotes', 'Search notes', 'Notes'],
  ['POST', '/v1/notes/bulk-delete', 'bulkDeleteNotes', 'Bulk delete notes', 'Notes'],
  ['GET', '/v1/notes/{noteId}/tags', 'listNoteTags', 'List note tags', 'Notes'],
  ['GET', '/v1/notes/{noteId}/summary', 'getNoteSummary', 'Get note summary', 'Notes'],
  ['POST', '/v1/days/{date}/bookings', 'createDayBooking', 'Create a day booking', 'Days'],
  ['DELETE', '/v1/days/{date}/bookings/{bookingId}', 'deleteDayBooking', 'Delete a day booking', 'Days'],
  ['GET', '/v1/task-lists/{taskListId}', 'getTaskList', 'Get a task list', 'Task lists'],
  ['GET', '/v1/task_lists', 'listTaskLists', 'List task lists', 'Task lists'],
  ['POST', '/v1/addresses', 'createAddress', 'Create an address', 'Addresses'],
  ['GET', '/v1/categories', 'listCategories', 'List categories', 'Categories'],
  ['GET', '/v1/statuses/{statusId}', 'getStatus', 'Get a status', 'Statuses'],
  [
    'GET',
    '/v1/patients/{patientId}/diagnoses/{diagnosisId}',
    'getPatientDiagnosis',
    'Get a patient diagnosis',
    'Patients',
  ],
  ['GET', '/v1/analytics', 'getAnalytics', 'Get analytics', 'Analytics'],
  ['GET', '/v1/me', 'getMe', 'Get me', 'Me'],
  ['GET', '/v1/me/appointments', 'listMyAppointments', 'List my appointments', 'Me'],
  ['POST', '/v1/me/verify-email', 'verifyMyEmail', 'Verify my email', 'Me'],
  ['POST', '/v1/me/logout', 'logoutMe', 'Logout me', 'Me'],
  ['GET', '/v1/greeting', 'getGreeting', 'Get greeting', 'Greeting'],
  ['POST', '/v1/greeting', 'createGreeting', 'Create a greeting', 'Greeting'],
  ['GET', '/v1/admin/notes', 'listAdminNotes', 'List admin notes', 'Admin'],
  ['GET', '/v2/notes', 'listNotesV2', 'List notes (v2)', 'Notes'],
  ['GET', '/notes/{noteId}', 'getNote', 'Get a note', 'Notes'],
  ['GET', '/v1/{id}', 'get', 'Get', undefined],
] as const;

it('names a route by what its method does to what its path names', () => {
  for (const [method, path, name, title, group] of ROUTES) {
    expect(
      [routeName(method, path), routeTitle(method, path), routeGroup(path)],
      `${method} ${path}`
    ).toEqual([name, title, group]);
  }
});

/** Each plural a path may name, and its singular. */
const SINGULARS = [
  ['notes', 'note'],
  ['categories', 'category'],
  ['days', 'day'],
  ['addresses', 'address'],
  ['boxes', 'box'],
  ['batches', 'batch'],
  ['wishes', 'wish'],
  ['statuses', 'status'],
  ['causes', 'cause'],
  ['doses', 'dose'],
  ['schemas', 'schema'],
  ['photos', 'photo'],
  ['people', 'person'],
  ['diagnoses', 'diagnosis'],
  ['analyses', 'analysis'],
  ['aliases', 'alias'],
  ['caches', 'cache'],
  ['headaches', 'headache'],
  ['movies', 'movie'],
  ['quizzes', 'quiz'],
  ['criteria', 'criterion'],
] as const;

/** Words that are already singular, or name one thing, and stay as they are. */
const UNCHANGED = ['status', 'address', 'analysis', 'data', 'news', 'series', 'alias', 'diabetes', 'me'];

it('finds the singular of the plurals a path names, and keeps the words that are singular', () => {
  expect(SINGULARS.map(([plural]) => singular(plural))).toEqual(SINGULARS.map(([, one]) => one));
  expect(UNCHANGED.map((word) => singular(word))).toEqual(UNCHANGED);
});
