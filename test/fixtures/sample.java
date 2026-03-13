import java.util.List;
import java.util.ArrayList;

public interface Repository<T> {
    T findById(int id);
    List<T> findAll();
}

public class UserService {
    private final List<String> users;

    public UserService() {
        this.users = new ArrayList<>();
    }

    public void addUser(String name) {
        users.add(name);
    }

    public List<String> getUsers() {
        return users;
    }

    @Override
    public String toString() {
        return "UserService";
    }

    @Deprecated
    public void removeAll() {
        users.clear();
    }
}
