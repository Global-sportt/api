import { AppError } from '../../common/errors/app-error';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  assertValidOperatingHours,
  findOperatingHourConflicts,
  ScheduleService,
} from './schedule.service';

const ESTABLISHMENT_ID = '11111111-1111-4111-8111-111111111111';
const SPACE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function hour(
  dayOfWeek: number,
  opensAtMinutes: number,
  closesAtMinutes: number,
) {
  return { dayOfWeek, opensAtMinutes, closesAtMinutes };
}

function expectAppError(
  work: () => unknown,
  status: number,
  code: string,
): AppError {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.getStatus()).toBe(status);
    expect(appError.code).toBe(code);
    return appError;
  }
  throw new Error(`Se esperaba un AppError ${status} ${code}`);
}

async function expectRejects(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.getStatus()).toBe(status);
    expect(appError.code).toBe(code);
    return appError;
  }
  throw new Error(`Se esperaba un AppError ${status} ${code}`);
}

describe('Validación de la grilla semanal', () => {
  it('acepta varias franjas del mismo día y franjas contiguas', () => {
    expect(() =>
      assertValidOperatingHours([
        hour(1, 9 * 60, 12 * 60),
        hour(1, 12 * 60, 18 * 60),
        hour(2, 8 * 60, 10 * 60),
      ]),
    ).not.toThrow();
    expect(
      findOperatingHourConflicts([
        hour(1, 9 * 60, 12 * 60),
        hour(1, 12 * 60, 18 * 60),
      ]),
    ).toEqual([]);
  });

  it('rechaza cruces del mismo día e indica el día y las franjas', () => {
    const error = expectAppError(
      () =>
        assertValidOperatingHours([
          hour(1, 9 * 60, 12 * 60),
          hour(1, 11 * 60, 14 * 60),
        ]),
      400,
      'VALIDATION_ERROR',
    );

    expect(error.message).toContain('lunes');
    expect(error.message).toContain('09:00-12:00');
    expect(error.message).toContain('11:00-14:00');
    expect(error.details).toEqual([
      expect.objectContaining({
        dayOfWeek: 1,
        constraints: ['overlap'],
        ranges: [
          { opensAtMinutes: 9 * 60, closesAtMinutes: 12 * 60 },
          { opensAtMinutes: 11 * 60, closesAtMinutes: 14 * 60 },
        ],
      }),
    ]);
  });

  it('rechaza aperturas duplicadas del mismo día', () => {
    const error = expectAppError(
      () =>
        assertValidOperatingHours([
          hour(3, 9 * 60, 11 * 60),
          hour(3, 9 * 60, 12 * 60),
        ]),
      400,
      'VALIDATION_ERROR',
    );

    expect(error.message).toContain('miércoles');
    expect(error.details).toEqual([
      expect.objectContaining({ constraints: ['duplicate'] }),
    ]);
  });

  it('rechaza una franja que termina antes de iniciar', () => {
    const error = expectAppError(
      () => assertValidOperatingHours([hour(5, 15 * 60, 14 * 60)]),
      400,
      'VALIDATION_ERROR',
    );

    expect(error.message).toContain('viernes');
    expect(error.message).toContain('15:00-14:00');
    expect(error.details).toEqual([
      expect.objectContaining({ constraints: ['range'] }),
    ]);
  });

  it('admite como máximo 50 franjas', () => {
    const hours = Array.from({ length: 51 }, (_, index) =>
      hour(index % 7, (index % 20) * 60, (index % 20) * 60 + 30),
    );
    // El tope se valida antes que los cruces: el mensaje es el de maxSize.
    const error = expectAppError(
      () => assertValidOperatingHours(hours),
      400,
      'VALIDATION_ERROR',
    );
    expect(error.message).toContain('50');
  });
});

describe('ScheduleService — validación de excepciones', () => {
  let service: ScheduleService;

  beforeEach(() => {
    service = new ScheduleService({} as unknown as PrismaService);
  });

  it('rechaza una excepción cerrada con horario', async () => {
    await expectRejects(
      service.upsertException(ESTABLISHMENT_ID, SPACE_ID, '2026-12-25', {
        isClosed: true,
        opensAtMinutes: 9 * 60,
        closesAtMinutes: 12 * 60,
      }),
      400,
      'VALIDATION_ERROR',
    );
  });

  it('rechaza una excepción abierta sin ambas horas', async () => {
    await expectRejects(
      service.upsertException(ESTABLISHMENT_ID, SPACE_ID, '2026-12-24', {
        isClosed: false,
        opensAtMinutes: 9 * 60,
      }),
      400,
      'VALIDATION_ERROR',
    );
  });

  it('rechaza una excepción con cierre anterior a la apertura', async () => {
    await expectRejects(
      service.upsertException(ESTABLISHMENT_ID, SPACE_ID, '2026-12-24', {
        isClosed: false,
        opensAtMinutes: 12 * 60,
        closesAtMinutes: 10 * 60,
      }),
      400,
      'VALIDATION_ERROR',
    );
  });

  it('rechaza una fecha de calendario imposible', async () => {
    await expectRejects(
      service.upsertException(ESTABLISHMENT_ID, SPACE_ID, '2026-02-30', {
        isClosed: true,
      }),
      400,
      'VALIDATION_ERROR',
    );
  });
});

describe('ScheduleService — consulta de la grilla', () => {
  it('responde 404 si la cancha no pertenece al establecimiento', async () => {
    const prisma = {
      space: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = new ScheduleService(prisma as unknown as PrismaService);

    await expectRejects(
      service.getOperatingHours(ESTABLISHMENT_ID, SPACE_ID),
      404,
      'SPACE_NOT_FOUND',
    );
    expect(prisma.space.findFirst).toHaveBeenCalledWith({
      where: { id: SPACE_ID, establishmentId: ESTABLISHMENT_ID },
      select: { id: true },
    });
  });

  it('devuelve las franjas ordenadas por día y apertura', async () => {
    const prisma = {
      space: { findFirst: jest.fn().mockResolvedValue({ id: SPACE_ID }) },
      operatingHour: {
        findMany: jest.fn().mockResolvedValue([
          { dayOfWeek: 1, opensAtMinutes: 9 * 60, closesAtMinutes: 11 * 60 },
          { dayOfWeek: 1, opensAtMinutes: 14 * 60, closesAtMinutes: 16 * 60 },
        ]),
      },
    };
    const service = new ScheduleService(prisma as unknown as PrismaService);

    const response = await service.getOperatingHours(
      ESTABLISHMENT_ID,
      SPACE_ID,
    );

    expect(response.hours).toEqual([
      { dayOfWeek: 1, opensAtMinutes: 9 * 60, closesAtMinutes: 11 * 60 },
      { dayOfWeek: 1, opensAtMinutes: 14 * 60, closesAtMinutes: 16 * 60 },
    ]);
    expect(prisma.operatingHour.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { spaceId: SPACE_ID },
        orderBy: [{ dayOfWeek: 'asc' }, { opensAtMinutes: 'asc' }],
      }),
    );
  });
});
