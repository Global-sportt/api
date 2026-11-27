import 'reflect-metadata';
import {
  AUTHORIZE_METADATA_KEY,
  Authorize,
  AuthorizeMetadata,
} from './authorize.decorator';

class TestController {
  @Authorize('booking', 'read')
  read(): void {}
}

describe('@Authorize', () => {
  it('adjunta el recurso, la acción y el código del catálogo', () => {
    const metadata = Reflect.getMetadata(
      AUTHORIZE_METADATA_KEY,
      TestController.prototype.read,
    ) as AuthorizeMetadata;

    expect(metadata).toEqual({
      resourceKind: 'booking',
      action: 'read',
      permission: 'booking:read',
    });
  });

  it('rechaza metadata vacía en tiempo de definición', () => {
    expect(() => Authorize('', 'read')).toThrow(/non-empty/);
    expect(() => Authorize('booking', '  ')).toThrow(/non-empty/);
  });
});
