import {
  hashIdentifier,
  isRelativePath,
  safeEqual,
  sha256,
} from './crypto.util';

describe('crypto.util', () => {
  it('compara strings en tiempo constante', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('hashea identificadores con HMAC de forma determinista', () => {
    expect(hashIdentifier('Persona@Example.com', 'secreto')).toBe(
      hashIdentifier('persona@example.com', 'secreto'),
    );
    expect(hashIdentifier('persona@example.com', 'secreto')).not.toBe(
      hashIdentifier('persona@example.com', 'otro'),
    );
  });

  it('calcula sha256 estable', () => {
    expect(sha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('acepta solo rutas relativas seguras', () => {
    expect(isRelativePath('/auth/callback')).toBe(true);
    expect(isRelativePath('//evil.example')).toBe(false);
    expect(isRelativePath('https://evil.example')).toBe(false);
    expect(isRelativePath('/ok\r\nLocation: evil')).toBe(false);
    expect(isRelativePath('/a\\b')).toBe(false);
  });
});
