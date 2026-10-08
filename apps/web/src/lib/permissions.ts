import type { PermissionCode } from '@bme/shared';

// What each permission means, in the words the hospital uses. The codes stay in the database and the API; people
// choosing what a role can do should never have to read them.
export const PERMISSION_TEXT: Record<PermissionCode, { label: string; hint: string }> = {
  'asset.view': { label: 'See equipment', hint: 'Open the register and each asset' },
  'asset.create': { label: 'Add equipment', hint: 'One at a time, or many from Excel' },
  'asset.edit': { label: 'Edit equipment details', hint: 'Name, dates, status and other everyday details' },
  'asset.edit_key': { label: 'Change key details without approval', hint: 'Serial number, equipment type, department and location. Without this, such changes wait for the HOD' },
  'asset.request_change': { label: 'Ask the HOD for changes', hint: 'Request key changes, condemnation, and removal of wrong entries' },
  'complaint.view': { label: 'See complaints', hint: 'The board and the history' },
  'complaint.create': { label: 'Raise complaints', hint: 'Report a fault on equipment they can see' },
  'complaint.start': { label: 'Start work on complaints', hint: 'Marks the response time' },
  'complaint.resolve': { label: 'Resolve complaints', hint: 'Marks the end of the downtime' },
  'expense.manage': { label: 'Record and see service costs', hint: 'Repairs, spare parts and their bills' },
  'pms.perform': { label: 'Do PMS and see due lists', hint: 'Fill the checklist, record corrections' },
  'calibration.manage': { label: 'Record calibration', hint: 'Dates, agency, result and certificate' },
  'approval.decide': { label: 'Approve or reject requests', hint: 'Normally only the Biomedical HOD' },
  'user.manage': { label: 'Manage users', hint: 'Add people, set passwords, deactivate' },
  'role.manage': { label: 'Change roles and permissions', hint: 'This screen' },
  'setup.manage': { label: 'Manage setup', hint: 'Departments, locations, equipment types, PMS checklists, hospital settings' },
  'settings.pattern': { label: 'Change the asset ID pattern', hint: 'Only possible before the first asset exists' },
  'audit.view': { label: 'See the audit log', hint: 'Who did what, and when' },
  'report.view': { label: 'See and export reports', hint: 'On screen, to Excel and to PDF' },
  'notification.view': { label: 'See reminders', hint: 'The bell: PMS, calibration, warranty and contracts' },
};
