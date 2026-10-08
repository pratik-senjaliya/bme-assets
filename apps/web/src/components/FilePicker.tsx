'use client';

import { PaperClipOutlined } from '@ant-design/icons';
import { App, Button, Upload } from 'antd';
import { ACCEPT, fileProblem } from '@/lib/uploads';

// Choose files now, upload them after the record is saved. Nothing is sent from here.
export function FilePicker({ files, onChange, label = 'Attach files', max = 5 }: { files: File[]; onChange: (f: File[]) => void; label?: string; max?: number }) {
  const { message } = App.useApp();
  return (
    <Upload
      multiple
      accept={ACCEPT}
      maxCount={max}
      fileList={files.map((f, i) => ({ uid: `${i}-${f.name}`, name: f.name, status: 'done' as const }))}
      beforeUpload={(file) => {
        const problem = fileProblem(file);
        if (problem) message.error(problem);
        else if (files.length >= max) message.error(`You can attach up to ${max} files`);
        else onChange([...files, file]);
        return false; // we upload ourselves, once the record exists
      }}
      onRemove={(item) => onChange(files.filter((f, i) => `${i}-${f.name}` !== item.uid))}
    >
      <Button icon={<PaperClipOutlined />}>{label}</Button>
    </Upload>
  );
}
