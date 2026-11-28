export type {
  IniComment,
  IniBlank,
  IniKeyValue,
  IniSection,
  IniItem,
  IniScalar,
  IniDocument,
} from './ini/types';
export { parseIniDoc } from './ini/parse';
export { stringifyIniDoc, formatIni } from './ini/stringify';
export { mergeIni } from './ini/merge';
