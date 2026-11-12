import * as fs from 'node:fs';
import * as path from 'node:path';

export const OFFICE_EXTENSIONS = [
  'doc', 'docx', 'docm', 'dot', 'dotx', 'dotm', 'rtf',
  'xls', 'xlsx', 'xlsm', 'xlsb', 'xlt', 'xltx', 'xltm',
  'ppt', 'pptx', 'pptm', 'pps', 'ppsx', 'ppsm', 'pot', 'potx', 'potm',
];

export function isOfficeDocument(name: string): boolean {
  return OFFICE_EXTENSIONS.includes(path.extname(name).slice(1).toLowerCase());
}

export function isOfficeOwnerFile(name: string): boolean {
  return name.startsWith('~$') && isOfficeDocument(name);
}

export function hasOfficeOwnerFile(file: string): boolean {
  if (!isOfficeDocument(file)) return false;
  const name = path.basename(file);
  const directory = path.dirname(file);
  // Office can prefix the full name or replace its first two characters.
  return fs.existsSync(path.join(directory, '~$' + name))
    || fs.existsSync(path.join(directory, '~$' + name.slice(2)));
}
