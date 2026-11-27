import { Injectable } from '@nestjs/common';
import { generateSlots } from './slot-generator';
import type {
  GenerateSlotsOptions,
  GeneratedSlot,
  SlotGeneratorInput,
} from './slot-generator.types';

/**
 * Injectable wrapper around the pure generator so T6 can compose the future
 * booking-availability filter without changing the controller or Prisma
 * access layer.
 */
@Injectable()
export class SlotsService {
  generate(
    input: SlotGeneratorInput,
    options?: GenerateSlotsOptions,
  ): GeneratedSlot[] {
    return generateSlots(input, options);
  }
}
