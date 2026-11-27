import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsUUID } from 'class-validator';
import { OWNER_GROUP_SLUG, STAFF_GROUP_SLUG } from '../../../common/authz/permissions';

export const ASSIGNABLE_TENANT_GROUP_SLUGS = [
  STAFF_GROUP_SLUG,
  OWNER_GROUP_SLUG,
] as const;

export type AssignableTenantGroupSlug =
  (typeof ASSIGNABLE_TENANT_GROUP_SLUGS)[number];

export class AddMembershipDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  userId!: string;

  @ApiProperty({ enum: ASSIGNABLE_TENANT_GROUP_SLUGS })
  @IsIn(ASSIGNABLE_TENANT_GROUP_SLUGS)
  groupSlug!: AssignableTenantGroupSlug;
}
