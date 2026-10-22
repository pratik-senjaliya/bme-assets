'use client';

import { Typography } from 'antd';
import { ImportWizard } from '@/components/ImportWizard';

export default function ImportUsersPage() {
  return (
    <ImportWizard
      permission="user.manage"
      forbidden="You cannot manage users"
      title="Import users from Excel"
      subtitle="Add the logins for a whole department at once"
      crumbs={['Admin', 'Users', 'Import']}
      templateHref="/api/v1/users/import/template"
      postPath="/users/import"
      noun={['user', 'users']}
      done={{ subTitle: 'Give each person their password; they choose their own when they first sign in.', href: '/admin/users', label: 'View users' }}
      intro={
        <Typography.Paragraph type="secondary">
          Fill one row per person: name, email, an optional short username, the role (Admin (Biomedical HOD), Biomedical staff or Nursing staff), the department code for nursing staff, and a first password of at least 8 characters. Everyone chooses their own password when they first sign in.
        </Typography.Paragraph>
      }
    />
  );
}
