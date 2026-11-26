import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notification } from '../entities/notification.entity';
import { DeadLetterNotification } from '../entities/dead-letter-notification.entity';
import { WebhookService } from './webhook.service';

const MAX_RETRIES = 5;

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notificationRepository: Repository<Notification>,
    @InjectRepository(DeadLetterNotification)
    private readonly deadLetterRepository: Repository<DeadLetterNotification>,
    private readonly webhookService: WebhookService,
  ) {}

  async deliver(notification: Notification): Promise<void> {
    try {
      await this.webhookService.send(notification);
      notification.status = 'delivered';
      notification.attempts = (notification.attempts ?? 0) + 1;
      await this.notificationRepository.save(notification);
    } catch (error) {
      notification.attempts = (notification.attempts ?? 0) + 1;
      notification.lastError = error instanceof Error ? error.message : String(error);

      if (notification.attempts >= MAX_RETRIES) {
        await this.moveToDeadLetter(notification, error);
        return;
      }

      notification.status = 'failed';
      await this.notificationRepository.save(notification);
    }
  }

  private async moveToDeadLetter(notification: Notification, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;

    const deadLetter = this.deadLetterRepository.create({
      notificationId: notification.id,
      merchantId: notification.merchantId,
      payload: notification.payload,
      attempts: notification.attempts,
      errorMessage: message,
      errorStack: stack,
      status: 'dead',
    });

    await this.deadLetterRepository.save(deadLetter);

    notification.status = 'dead';
    await this.notificationRepository.save(notification);

    this.logger.warn(
      `Notification ${notification.id} moved to DLQ after ${notification.attempts} attempts: ${message}`,
    );
  }

  async listDeadLetters(merchantId: string): Promise<DeadLetterNotification[]> {
    return this.deadLetterRepository.find({
      where: { merchantId },
      order: { createdAt: 'DESC' },
    });
  }

  async retryDeadLetter(merchantId: string, deadLetterId: string): Promise<Notification> {
    const deadLetter = await this.deadLetterRepository.findOne({
      where: { id: deadLetterId, merchantId },
    });

    if (!deadLetter) {
      throw new NotFoundException(`Dead-letter notification ${deadLetterId} not found`);
    }

    const notification = await this.notificationRepository.findOne({
      where: { id: deadLetter.notificationId },
    });

    if (!notification) {
      throw new NotFoundException(`Notification ${deadLetter.notificationId} not found`);
    }

    notification.status = 'pending';
    notification.attempts = 0;
    notification.lastError = null;
    await this.notificationRepository.save(notification);

    await this.deadLetterRepository.remove(deadLetter);

    await this.deliver(notification);

    return notification;
  }
}
