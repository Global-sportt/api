import { EstablishmentStatus, SpaceStatus } from '@prisma/client';
import { AppError } from '../../common/errors/app-error';
import type { PrismaService } from '../../prisma/prisma.service';
import { SlotsService } from './slots.service';
import { SpacesService } from './spaces.service';

const ESTABLISHMENT_ID = '11111111-1111-4111-8111-111111111111';
const SPACE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MONDAY = '2026-06-15';

async function expectAppError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  try {
    await promise;
    throw new Error(`Se esperaba un AppError ${status} ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.getStatus()).toBe(status);
    expect(appError.code).toBe(code);
  }
}

function activeSpace() {
  return {
    id: SPACE_ID,
    name: 'Cancha 1',
    slug: 'cancha-1',
    sport: 'futbol',
    slotMinutes: 60,
    bufferMinutes: 0,
    status: SpaceStatus.active,
    operatingHours: [
      { dayOfWeek: 1, opensAtMinutes: 9 * 60, closesAtMinutes: 12 * 60 },
    ],
    priceRules: [],
  };
}

describe('SpacesService', () => {
  let prisma: {
    establishment: { findUnique: jest.Mock };
    space: { findMany: jest.Mock; findFirst: jest.Mock };
    scheduleException: { findMany: jest.Mock };
  };
  let service: SpacesService;

  beforeEach(() => {
    prisma = {
      establishment: { findUnique: jest.fn() },
      space: { findMany: jest.fn(), findFirst: jest.fn() },
      scheduleException: { findMany: jest.fn() },
    };
    service = new SpacesService(
      prisma as unknown as PrismaService,
      new SlotsService(),
    );
  });

  it('lista las canchas del establecimiento con sus horarios', async () => {
    prisma.establishment.findUnique.mockResolvedValue({
      id: ESTABLISHMENT_ID,
      timezone: 'America/Bogota',
      currency: 'COP',
    });
    prisma.space.findMany.mockResolvedValue([
      {
        ...activeSpace(),
        createdAt: new Date('2026-06-01T12:00:00.000Z'),
        updatedAt: new Date('2026-06-02T12:00:00.000Z'),
      },
    ]);

    const spaces = await service.listSpaces(ESTABLISHMENT_ID);

    expect(prisma.space.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { establishmentId: ESTABLISHMENT_ID } }),
    );
    expect(spaces).toEqual([
      expect.objectContaining({
        id: SPACE_ID,
        name: 'Cancha 1',
        operatingHours: [
          { dayOfWeek: 1, opensAtMinutes: 540, closesAtMinutes: 720 },
        ],
      }),
    ]);
  });

  it('devuelve 404 ESTABLISHMENT_NOT_FOUND si el tenant no existe', async () => {
    prisma.establishment.findUnique.mockResolvedValue(null);

    await expectAppError(
      service.listSpaces(ESTABLISHMENT_ID),
      404,
      'ESTABLISHMENT_NOT_FOUND',
    );
  });

  it('devuelve 404 SPACE_NOT_FOUND para una cancha de otro tenant', async () => {
    prisma.establishment.findUnique.mockResolvedValue({
      id: ESTABLISHMENT_ID,
      timezone: 'America/Bogota',
      currency: 'COP',
    });
    prisma.space.findFirst.mockResolvedValue(null);

    await expectAppError(
      service.getAvailability(ESTABLISHMENT_ID, SPACE_ID, MONDAY),
      404,
      'SPACE_NOT_FOUND',
    );
  });

  it('no expone establecimientos inactivos en la ruta pública', async () => {
    prisma.establishment.findUnique.mockResolvedValue({
      id: ESTABLISHMENT_ID,
      timezone: 'America/Bogota',
      currency: 'COP',
      status: EstablishmentStatus.suspended,
      spaces: [activeSpace()],
    });

    await expectAppError(
      service.getPublicAvailability('slug', MONDAY),
      404,
      'ESTABLISHMENT_NOT_FOUND',
    );
  });

  it('respeta una excepción cerrada en la disponibilidad pública', async () => {
    prisma.establishment.findUnique.mockResolvedValue({
      id: ESTABLISHMENT_ID,
      timezone: 'America/Bogota',
      currency: 'COP',
      status: EstablishmentStatus.active,
      spaces: [activeSpace()],
    });
    prisma.scheduleException.findMany.mockResolvedValue([
      {
        spaceId: SPACE_ID,
        date: new Date(`${MONDAY}T00:00:00.000Z`),
        isClosed: true,
        opensAtMinutes: null,
        closesAtMinutes: null,
        reason: 'Mantenimiento',
      },
    ]);

    const result = await service.getPublicAvailability('slug', MONDAY);

    expect(result.spaces).toHaveLength(1);
    expect(result.spaces[0].slots).toEqual([]);
  });

  it('devuelve 400 VALIDATION_ERROR con una fecha imposible', async () => {
    await expectAppError(
      service.getPublicAvailability('slug', '2026-02-30'),
      400,
      'VALIDATION_ERROR',
    );
    expect(prisma.establishment.findUnique).not.toHaveBeenCalled();
  });
});
