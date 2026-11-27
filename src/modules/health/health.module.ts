import { Module } from '@nestjs/common';
import { AuthzModule } from '../../common/authz/authz.module';
import { HealthController } from './health.controller';

@Module({
  imports: [AuthzModule],
  controllers: [HealthController],
})
export class HealthModule {}
