import { ApiPropertyOptional } from '@nestjs/swagger';
import { MembershipStatus } from '@prisma/client';
import { IsEnum, IsIn, IsOptional } from 'class-validator';
import {
  ASSIGNABLE_TENANT_GROUP_SLUGS,
  type AssignableTenantGroupSlug,
} from './add-membership.dto';

export class UpdateMembershipDto {
  @ApiPropertyOptional({ enum: MembershipStatus })
  @IsOptional()
  @IsEnum(MembershipStatus)
  status?: MembershipStatus;

  @ApiPropertyOptional({ enum: ASSIGNABLE_TENANT_GROUP_SLUGS })
  @IsOptional()
  @IsIn(ASSIGNABLE_TENANT_GROUP_SLUGS)
  groupSlug?: AssignableTenantGroupSlug;
}
