<?php

namespace App\Models;

use App\Interfaces\Renderable;
use App\Traits\HasTimestamps;
use Illuminate\Database\Eloquent\Model;

interface Renderable
{
    public function render(): string;
    public function getTemplate(): string;
}

trait HasTimestamps
{
    public function getCreatedAt(): string
    {
        return $this->created_at;
    }

    public function touch(): void
    {
        $this->updated_at = date('Y-m-d H:i:s');
    }
}

class User extends Model implements Renderable
{
    use HasTimestamps;

    private string $name;
    protected string $email;

    public function __construct(string $name, string $email)
    {
        $this->name = $name;
        $this->email = $email;
    }

    public function render(): string
    {
        return "<div>{$this->name}</div>";
    }

    public function getTemplate(): string
    {
        return 'user.html';
    }

    public function getName(): string
    {
        return $this->name;
    }

    private function validateEmail(): bool
    {
        return filter_var($this->email, FILTER_VALIDATE_EMAIL) !== false;
    }
}

class Admin extends User
{
    private array $permissions;

    public function hasPermission(string $permission): bool
    {
        return in_array($permission, $this->permissions);
    }
}

function formatUser(User $user): string
{
    return "User: " . $user->getName();
}
